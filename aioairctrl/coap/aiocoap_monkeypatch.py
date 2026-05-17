import asyncio
import functools

from aiocoap.messagemanager import MessageManager
from aiocoap.numbers.constants import EXCHANGE_LIFETIME


def _deduplicate_message(self, message):
    key = (message.remote, message.mid)
    self.log.debug("MP: New unique message received")
    self.loop.call_later(EXCHANGE_LIFETIME, functools.partial(self._recent_messages.pop, key))
    self._recent_messages[key] = None
    return False


MessageManager._deduplicate_message = _deduplicate_message

from aiocoap.protocol import ClientObservation
from aiocoap.error import ObservationCancelled, NotObservable, LibraryShutdown


def __del__(self):
    if self._future.done():
        try:
            self._future.result()
        except (ObservationCancelled, NotObservable):
            pass
        except LibraryShutdown:
            pass
        except asyncio.CancelledError:
            pass


ClientObservation._Iterator.__del__ = __del__
