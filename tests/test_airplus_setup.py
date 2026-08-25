"""Regression tests for Philips Air+ setup token validation."""

import io
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


if __name__ == "__main__":
    unittest.main()
