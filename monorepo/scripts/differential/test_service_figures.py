#!/usr/bin/env python3
"""The tests of the figures script of piece 7 (Python 3, standard library): `python3 -m unittest -v test_service_figures` from this directory, or through the file named in the `differential` suite.

  Figures   the median, the range and the count of a figure (a missing reading is left out), the count of the non-zero statuses and of the retries of a series, and the table of a result
  Refusal   a run into a directory that is not empty is refused and starts nothing; the wrapper of the sampled run reads a lock that is missing or not JSON as no lock

No service is started. Only scratch directories are used.
"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sampled_run  # noqa: E402
import service_figures as sf  # noqa: E402


class Figures(unittest.TestCase):
    def test_stats_leave_out_a_missing_reading(self):
        self.assertEqual(sf.stats([3.0, None, 1.0, 2.0]), {"n": 3, "median": 2.0, "min": 1.0, "max": 3.0})
        self.assertEqual(sf.stats([]), {"n": 0})
        self.assertEqual(sf.stats([None]), {"n": 0})

    def test_status_counts(self):
        rows = [{"status": 0, "retries": 0}, {"status": 1, "retries": 2}, {"showStatus": None}, {"showStatus": 0}]
        self.assertEqual(sf.status_counts(rows), {"status": 1, "retries": 2, "showStatus=None": 1})

    def test_the_table_names_the_series_and_the_rule(self):
        starts = [{"ready": 1.8, "call": 5.4, "ping": 5.4, "show1": 0.4, "show2": 0.4, "flush": 0.3, "rssAtPing": 1, "rssAfterShow": 1, "rssAfterFlush": 1, "peakAfterFlush": 2, "checkLinks": 3.5, "loadBefore": 1.0},
                  {"ready": 6.0, "call": 5.4, "ping": 6.1, "show1": 0.4, "show2": 0.4, "flush": 0.3, "rssAtPing": 1, "rssAfterShow": 1, "rssAfterFlush": 1, "peakAfterFlush": 2, "checkLinks": 3.5, "loadBefore": 1.5}]
        text = sf.tables({"starts": {"new": {"gate": {"loadavg": "1.0 1.0 1.0"}, "rows": starts}}})
        self.assertIn("== starts, new", text)
        self.assertIn("ready under 5.000 s: 1 of 2 starts", text)
        self.assertIn("n=2  median 3.9  range 1.8 to 6.0", text)


class Refusal(unittest.TestCase):
    def test_a_directory_that_is_not_empty_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "x"), "w").close()
            self.assertEqual(sf.main(["--out", d, "--ports", "2861,2862"]), 2)

    def test_a_missing_or_bad_lock_is_no_lock(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(sampled_run.lock_info(os.path.join(d, "none.lock")))
            bad = os.path.join(d, "bad.lock")
            with open(bad, "w") as h:
                h.write("{not json")
            self.assertIsNone(sampled_run.lock_info(bad))
            good = os.path.join(d, "good.lock")
            with open(good, "w") as h:
                h.write('{"pid": 7, "status": "ready"}')
            self.assertEqual(sampled_run.lock_info(good)["pid"], 7)


if __name__ == "__main__":
    unittest.main()
