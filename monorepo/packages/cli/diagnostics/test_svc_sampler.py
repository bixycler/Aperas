"""Tests for svc_sampler.py: the raw-socket ping against a fake service, and --report's stall and slope math.

  python3 -m unittest monorepo/packages/cli/diagnostics/test_svc_sampler.py
  npm run svc:sample:test        (from monorepo/)
"""
import io
import os
import socket
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svc_sampler as s  # noqa: E402


class FakeService:
    """A unix-socket server answering one line per connection after `delay` seconds, with `reply` bytes."""

    def __init__(self, path: str, reply: bytes | None, delay: float = 0.0):
        self.path, self.reply, self.delay = path, reply, delay
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(4)
        self.t = threading.Thread(target=self._serve, daemon=True)
        self.t.start()

    def _serve(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            try:
                c.recv(1024)
                threading.Event().wait(self.delay)
                if self.reply is not None:
                    c.sendall(self.reply)
            except OSError:
                pass
            finally:
                c.close()

    def close(self):
        self.srv.close()


class PingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "s.sock")

    def tearDown(self):
        for f in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, f))
        os.rmdir(self.dir)

    def test_ok(self):
        svc = FakeService(self.path, b'{"ok":true,"result":{"pong":true}}\n')
        try:
            r = s.ping(self.path, 2.0)
        finally:
            svc.close()
        self.assertEqual(r["ok"], 1)
        self.assertEqual(r["err"], "")
        self.assertNotEqual(r["ping_ms"], "")

    def test_missing_socket_keeps_text(self):
        r = s.ping(self.path, 1.0)
        self.assertEqual(r["ok"], 0)
        self.assertIn("socket missing", r["err"])

    def test_refused_keeps_text(self):
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)  # a socket file with nobody listening
        srv.close()
        r = s.ping(self.path, 1.0)
        self.assertEqual(r["ok"], 0)
        self.assertIn("ConnectionRefusedError", r["err"])

    def test_no_reply_is_a_timeout_after_connect(self):
        svc = FakeService(self.path, None, delay=2.0)
        try:
            r = s.ping(self.path, 0.3)
        finally:
            svc.close()
        self.assertEqual(r["ok"], 0)
        self.assertIn("no reply in 0.3 s (connected after", r["err"])
        self.assertNotEqual(r["connect_ms"], "")

    def test_not_ok_reply(self):
        svc = FakeService(self.path, b'{"ok":false,"error":"boom"}\n')
        try:
            r = s.ping(self.path, 2.0)
        finally:
            svc.close()
        self.assertEqual(r["ok"], 0)
        self.assertIn("boom", r["err"])


def make_rows(spec):
    """spec: list of (epoch, ping_ok, ping_ms, pid, rss_mb)."""
    rows = []
    for t, ok, ms, pid, rss in spec:
        rows.append({"ts": f"2026-01-01 00:00:{int(t) % 60:02d}", "epoch": str(float(t)), "pid": str(pid),
                     "ping_ok": str(ok), "ping_ms": "" if ms is None else str(ms), "ping_err": "" if ok else "no reply",
                     "rss_mb": str(rss), "clients": "0"})
    return rows


class ReportMathTests(unittest.TestCase):
    def test_stall_duration_runs_to_next_good_tick(self):
        rows = make_rows([(0, 1, 5, 1, 100), (1, 1, 5, 1, 100), (2, 0, None, 1, 100), (7, 0, None, 1, 100),
                          (12, 0, None, 1, 100), (13, 1, 5, 1, 100)])
        epochs = s.row_epochs(rows)
        out = s.stalls(rows, epochs, 1000)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["ticks"], 3)
        self.assertAlmostEqual(out[0]["duration_s"], 11.0)  # tick at 2 s to the good tick at 13 s

    def test_slow_reply_is_a_stall_and_open_stall_is_flagged(self):
        rows = make_rows([(0, 1, 5, 1, 100), (1, 1, 2500, 1, 100), (2, 1, 2600, 1, 100)])
        out = s.stalls(rows, s.row_epochs(rows), 1000)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].get("open"))
        self.assertEqual(out[0]["worst_ms"], 2600.0)

    def test_slope_is_mb_per_minute(self):
        pts = [(t, 100 + t * 0.5) for t in range(0, 600, 10)]  # 0.5 MB/s = 30 MB/min
        self.assertAlmostEqual(s.slope_mb_per_min(pts), 30.0, places=6)
        self.assertIsNone(s.slope_mb_per_min(pts[:2]))

    def test_slope_resets_per_pid(self):
        spec = [(t, 1, 5, 11, 100 + t) for t in range(0, 60, 10)] + [(t, 1, 5, 22, 500) for t in range(60, 120, 10)]
        rows = make_rows(spec)
        by = {m["pid"]: m for m in s.memory_slopes(rows, s.row_epochs(rows))}
        self.assertAlmostEqual(by["11"]["rss_slope"], 60.0, places=6)
        self.assertAlmostEqual(by["22"]["rss_slope"], 0.0, places=6)

    def test_legacy_hms_timestamps_cross_midnight(self):
        rows = [{"ts": "23:59:58"}, {"ts": "00:00:02"}]
        self.assertEqual(s.row_epochs(rows), [86398, 86402])

    def test_report_prints_on_a_csv_file(self):
        import csv
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="") as f:
            w = csv.DictWriter(f, s.COLS)
            w.writeheader()
            for r in make_rows([(0, 1, 5, 1, 100), (1, 0, None, 1, 101), (2, 1, 5, 1, 102), (3, 1, 5, 1, 103)]):
                w.writerow({c: r.get(c, "") for c in s.COLS})
            path = f.name
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                s.report(path)
        finally:
            os.unlink(path)
        text = buf.getvalue()
        self.assertIn("stalls (ping failed or slower than 1000 ms): 1", text)
        self.assertIn("no reply", text)
        self.assertIn("rss slope", text)


if __name__ == "__main__":
    unittest.main()
