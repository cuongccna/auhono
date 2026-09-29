#!/usr/bin/env python3
"""Test cho tools/flash_identity.py (không cần chip/esptool): chạy `python3 -m unittest tools/test_flash_identity.py -v`
hoặc `python3 tools/test_flash_identity.py` từ thư mục firmware/."""
import contextlib
import csv
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flash_identity as fi  # noqa: E402

KEY = "41bc43e33ceb8fd260f6888bcf8b89858310b99545a24ac3a6a76bb1b7b8a507"
DEV = "AUH-000001"


def write_csv(rows, header):
    fd, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    return path


class ApDerivation(unittest.TestCase):
    def test_protocol_vector(self):
        self.assertEqual(fi.derive_ap_password(KEY), "XP1CZHP3Z0")
        self.assertEqual(fi.derive_ap_ssid(DEV), "Auhono-0001")
        self.assertEqual(fi.derive_wifi_qr(DEV, KEY), "WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;")

    def test_alphabet_length_and_short_ids(self):
        import random
        rnd = random.Random(1)
        for _ in range(500):
            pw = fi.derive_ap_password("".join(rnd.choice("0123456789abcdef") for _ in range(64)))
            self.assertEqual(len(pw), 10)
            self.assertTrue(set(pw) <= set(fi.AP_ALPHABET))
        self.assertEqual(fi.derive_ap_ssid("AUH-12"), "Auhono-H-12")
        self.assertEqual(fi.derive_ap_ssid("ABC"), "Auhono-ABC")
        self.assertEqual(fi.derive_ap_ssid(""), "Auhono-0000")


class CsvChecks(unittest.TestCase):
    OLD = ["device_id", "device_key_hex", "activation_code", "qr_payload"]
    NEW = OLD + ["ap_ssid", "ap_password", "wifi_qr_payload"]

    def read(self, path):
        with contextlib.redirect_stderr(io.StringIO()):
            return fi.read_row(path, DEV)

    def test_old_csv_without_ap_columns_still_works(self):
        p = write_csv([[DEV, KEY, "ABCDEFGHJK", "auh://x"]], self.OLD)
        self.assertEqual(self.read(p), (DEV, KEY))

    def test_new_csv_with_matching_columns_and_extra_unknown_column(self):
        row = [DEV, KEY, "ABCDEFGHJK", "auh://x", "Auhono-0001", "XP1CZHP3Z0", "WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;", "extra"]
        p = write_csv([row], self.NEW + ["something_new"])
        self.assertEqual(self.read(p), (DEV, KEY))

    def test_mismatch_is_refused(self):
        for col_idx, bad in ((4, "Auhono-0002"), (5, "AAAAAAAAAA"), (6, "WIFI:T:WPA;S:Auhono-0001;P:AAAAAAAAAA;H:false;;")):
            row = [DEV, KEY, "ABCDEFGHJK", "auh://x", "Auhono-0001", "XP1CZHP3Z0", "WIFI:T:WPA;S:Auhono-0001;P:XP1CZHP3Z0;H:false;;"]
            row[col_idx] = bad
            p = write_csv([row], self.NEW)
            with self.assertRaises(SystemExit):
                self.read(p)

    def test_refusal_message_never_contains_the_password(self):
        row = [DEV, KEY, "ABCDEFGHJK", "auh://x", "Auhono-0001", "AAAAAAAAAA", ""]
        p = write_csv([row], self.NEW)
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            fi.read_row(p, DEV)
        self.assertNotIn("XP1CZHP3Z0", err.getvalue())
        self.assertNotIn("AAAAAAAAAA", err.getvalue())

    def test_empty_optional_columns_are_ignored(self):
        p = write_csv([[DEV, KEY, "ABCDEFGHJK", "auh://x", "", "", ""]], self.NEW)
        self.assertEqual(self.read(p), (DEV, KEY))


if __name__ == "__main__":
    unittest.main()
