"""Regression tests for Philips Air+ setup token validation."""

import io
import json
import os
import stat
import tempfile
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import airplus_setup  # noqa: E402


class AirPlusSetupTests(unittest.TestCase):
    def test_missing_or_empty_id_token_fails_before_writing_token_file(self):
        for id_token in (None, ""):
            token_response = {
                "access_token": "access-token",
                "refresh_token": "refresh-token",
            }
            if id_token is not None:
                token_response["id_token"] = id_token

            error_output = io.StringIO()
            with self.subTest(id_token=id_token):
                with mock.patch.object(airplus_setup, "_save_tokens") as save_tokens:
                    with redirect_stderr(error_output):
                        result = airplus_setup._save_selected_device(token_response)

                self.assertEqual(result, 1)
                save_tokens.assert_not_called()
                self.assertIn("No id_token in token response", error_output.getvalue())


class TokenFileTests(unittest.TestCase):
    def test_invalid_device_ids_create_nothing(self):
        for uuid in ("../x", "a/b", "..", "", "a" * 129, "a.b", "a\\b", "valid\n", None, 123):
            with self.subTest(uuid=uuid), tempfile.TemporaryDirectory() as home:
                with mock.patch.object(airplus_setup.os.path, "expanduser", return_value=home):
                    with mock.patch.object(airplus_setup.os, "makedirs") as mkdir:
                        with self.assertRaisesRegex(ValueError, "Device UUID"):
                            airplus_setup._save_tokens(uuid, "access", "refresh", "identity", 123)
                    mkdir.assert_not_called()
                self.assertEqual(list(Path(home).iterdir()), [])

    def test_token_file_is_owner_only_throughout_write_and_replace(self):
        real_open = os.open
        real_dump = json.dump
        real_replace = os.replace
        seen_paths = []

        def checked_open(path, flags, mode):
            self.assertEqual(mode, 0o600)
            self.assertEqual(flags, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            self.assertNotIn(path, seen_paths)
            seen_paths.append(path)
            fd = real_open(path, flags, mode)
            self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o600)
            return fd

        def checked_dump(payload, file, **kwargs):
            self.assertEqual(stat.S_IMODE(os.fstat(file.fileno()).st_mode), 0o600)
            real_dump(payload, file, **kwargs)

        def checked_replace(source, target):
            self.assertEqual(Path(source).parent, Path(target).parent)
            self.assertEqual(stat.S_IMODE(os.stat(source).st_mode), 0o600)
            real_replace(source, target)
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)

        with tempfile.TemporaryDirectory() as home:
            with mock.patch.object(airplus_setup.os.path, "expanduser", return_value=home):
                with mock.patch.object(airplus_setup.os, "open", side_effect=checked_open):
                    with mock.patch.object(airplus_setup.json, "dump", side_effect=checked_dump):
                        with mock.patch.object(airplus_setup.os, "replace", side_effect=checked_replace):
                            for uuid in ("device-uuid-1", "00000000-0000-4000-8000-000000000000", "AIRPLUS_DEVICE_UUID", "a" * 128):
                                for _ in range(2):
                                    token_path = airplus_setup._save_tokens(uuid, "access", "refresh", "identity", 123)
                                self.assertEqual(Path(token_path).name, f"philips-airplus-{uuid}.json")
                                self.assertEqual(json.loads(Path(token_path).read_text()), {
                                    "access_token": "access", "refresh_token": "refresh", "id_token": "identity",
                                    "client_id": airplus_setup.CLIENT_ID, "expires_at": 123,
                                })
            self.assertEqual(len(list((Path(home) / ".homebridge").iterdir())), 4)

    def test_failed_write_preserves_existing_tokens_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.object(airplus_setup.os.path, "expanduser", return_value=home):
                token_path = Path(airplus_setup._save_tokens("device-1", "old", "refresh", "identity", 123))
                original = token_path.read_bytes()
                with mock.patch.object(airplus_setup.json, "dump", side_effect=OSError("write failed")):
                    with self.assertRaisesRegex(OSError, "write failed"):
                        airplus_setup._save_tokens("device-1", "new", "refresh", "identity", 123)
                self.assertEqual(token_path.read_bytes(), original)
                self.assertEqual(list(token_path.parent.iterdir()), [token_path])


if __name__ == "__main__":
    unittest.main()
