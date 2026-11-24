"""Pure-Python AES (FIPS-197) in CBC mode, plus PKCS7 padding.

Replaces pycryptodomex so the plugin needs no compiled dependencies and no
install step. It mirrors the small subset of the Cryptodome API the plugin
uses (``AES.new(key, AES.MODE_CBC, iv=...)``, ``pad``, ``unpad``), so call
sites are unchanged.

Device payloads are about 1 KB, so pure-Python speed is irrelevant. This is
NOT constant-time. That is acceptable here (the CoAP key is a published
protocol constant; HTTP/HomeID keys never leave the local network) but do
not reuse this module for anything else.

Correctness is pinned by tests/test_aes.py: FIPS-197 and SP 800-38A
vectors, plus vectors recorded from pycryptodomex.
"""

_BLOCK = 16


def _as_bytes(value, what):
    # bytes(int) silently yields zero bytes, so reject non-bytes-like input
    # (Cryptodome raises TypeError here too).
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError(f"{what} must be bytes-like, not {type(value).__name__}")
    return bytes(value)


def _xtime(a):
    a <<= 1
    return (a ^ 0x11B) if a & 0x100 else a


def _gmul(a, b):
    result = 0
    while b:
        if b & 1:
            result ^= a
        a = _xtime(a)
        b >>= 1
    return result


def _build_sboxes():
    # Walk GF(2^8) with generator 3 (p) and its inverse (q), so q = p^-1,
    # then apply the FIPS-197 affine transform. Computing the tables avoids
    # transcribing 512 constants by hand.
    sbox = [0] * 256
    p = q = 1
    while True:
        p ^= _xtime(p)
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q
        for shift in (1, 2, 3, 4):
            x ^= ((q << shift) | (q >> (8 - shift))) & 0xFF
        sbox[p] = x ^ 0x63
        if p == 1:
            break
    sbox[0] = 0x63
    inv = [0] * 256
    for i, v in enumerate(sbox):
        inv[v] = i
    return sbox, inv


_SBOX, _INV_SBOX = _build_sboxes()
_MUL = {n: [_gmul(i, n) for i in range(256)] for n in (2, 3, 9, 11, 13, 14)}

# State is a flat list of 16 bytes, column-major (index = 4 * column + row),
# which is also the input byte order. Row r shifts left by r columns.
_SHIFT_ROWS = [r + 4 * ((c + r) % 4) for c in range(4) for r in range(4)]
_INV_SHIFT_ROWS = [r + 4 * ((c - r) % 4) for c in range(4) for r in range(4)]


def _expand_key(key):
    nk = len(key) // 4
    rounds = nk + 6
    words = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    rcon = 1
    for i in range(nk, 4 * (rounds + 1)):
        temp = list(words[i - 1])
        if i % nk == 0:
            temp = [_SBOX[b] for b in temp[1:] + temp[:1]]
            temp[0] ^= rcon
            rcon = _xtime(rcon)
        elif nk > 6 and i % nk == 4:
            temp = [_SBOX[b] for b in temp]
        words.append([words[i - nk][j] ^ temp[j] for j in range(4)])
    return [sum(words[4 * r:4 * r + 4], []) for r in range(rounds + 1)]


def _mix_columns(s):
    m2, m3 = _MUL[2], _MUL[3]
    out = [0] * 16
    for c in range(0, 16, 4):
        a0, a1, a2, a3 = s[c:c + 4]
        out[c] = m2[a0] ^ m3[a1] ^ a2 ^ a3
        out[c + 1] = a0 ^ m2[a1] ^ m3[a2] ^ a3
        out[c + 2] = a0 ^ a1 ^ m2[a2] ^ m3[a3]
        out[c + 3] = m3[a0] ^ a1 ^ a2 ^ m2[a3]
    return out


def _inv_mix_columns(s):
    m9, m11, m13, m14 = _MUL[9], _MUL[11], _MUL[13], _MUL[14]
    out = [0] * 16
    for c in range(0, 16, 4):
        a0, a1, a2, a3 = s[c:c + 4]
        out[c] = m14[a0] ^ m11[a1] ^ m13[a2] ^ m9[a3]
        out[c + 1] = m9[a0] ^ m14[a1] ^ m11[a2] ^ m13[a3]
        out[c + 2] = m13[a0] ^ m9[a1] ^ m14[a2] ^ m11[a3]
        out[c + 3] = m11[a0] ^ m13[a1] ^ m9[a2] ^ m14[a3]
    return out


def _encrypt_block(round_keys, block):
    s = [b ^ k for b, k in zip(block, round_keys[0])]
    last = len(round_keys) - 1
    for rnd in range(1, last + 1):
        s = [_SBOX[s[i]] for i in _SHIFT_ROWS]
        if rnd != last:
            s = _mix_columns(s)
        s = [b ^ k for b, k in zip(s, round_keys[rnd])]
    return s


def _decrypt_block(round_keys, block):
    last = len(round_keys) - 1
    s = [b ^ k for b, k in zip(block, round_keys[last])]
    for rnd in range(last - 1, -1, -1):
        s = [_INV_SBOX[s[i]] for i in _INV_SHIFT_ROWS]
        s = [b ^ k for b, k in zip(s, round_keys[rnd])]
        if rnd != 0:
            s = _inv_mix_columns(s)
    return s


class _CBCCipher:
    def __init__(self, key, iv):
        key = _as_bytes(key, "key")
        iv = _as_bytes(iv, "iv")
        if len(key) not in (16, 24, 32):
            raise ValueError(f"Incorrect AES key length ({len(key)} bytes)")
        if len(iv) != _BLOCK:
            raise ValueError(f"Incorrect IV length ({len(iv)} bytes)")
        self._round_keys = _expand_key(key)
        self._prev = list(iv)

    @staticmethod
    def _check_length(data):
        data = _as_bytes(data, "data")
        if len(data) % _BLOCK:
            raise ValueError("Data must be padded to 16 byte boundary in CBC mode")
        return data

    def encrypt(self, plaintext):
        data = self._check_length(plaintext)
        out = bytearray()
        for i in range(0, len(data), _BLOCK):
            block = [b ^ p for b, p in zip(data[i:i + _BLOCK], self._prev)]
            self._prev = _encrypt_block(self._round_keys, block)
            out.extend(self._prev)
        return bytes(out)

    def decrypt(self, ciphertext):
        data = self._check_length(ciphertext)
        out = bytearray()
        for i in range(0, len(data), _BLOCK):
            block = list(data[i:i + _BLOCK])
            plain = _decrypt_block(self._round_keys, block)
            out.extend(b ^ p for b, p in zip(plain, self._prev))
            self._prev = block
        return bytes(out)


class AES:
    """Minimal stand-in for ``Cryptodome.Cipher.AES`` (CBC mode only)."""

    MODE_CBC = 2
    block_size = _BLOCK

    @staticmethod
    def new(key, mode, iv):
        if mode != AES.MODE_CBC:
            raise ValueError("Only AES.MODE_CBC is supported")
        return _CBCCipher(key, iv)


def _check_style(block_size, style):
    if style != "pkcs7":
        raise ValueError("Only pkcs7 padding is supported")
    if not 1 <= block_size <= 255:
        raise ValueError("block_size must be between 1 and 255")


def pad(data, block_size, style="pkcs7"):
    _check_style(block_size, style)
    data = _as_bytes(data, "data")
    count = block_size - len(data) % block_size
    return data + bytes([count]) * count


def unpad(data, block_size, style="pkcs7"):
    _check_style(block_size, style)
    data = _as_bytes(data, "data")
    if not data or len(data) % block_size:
        raise ValueError("Input data is not padded")
    count = data[-1]
    if not 1 <= count <= block_size or data[-count:] != bytes([count]) * count:
        raise ValueError("Padding is incorrect.")
    return data[:-count]
