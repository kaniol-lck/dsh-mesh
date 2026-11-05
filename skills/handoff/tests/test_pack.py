#!/usr/bin/env python3
"""Offline tests for handoff pack: binary skipping, real-secret refusal, no duplicate entries.

Run: python skills/handoff/tests/test_pack.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "handoff.py"


def pack(workspace: Path, out: Path) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "pack", "--workspace", str(workspace), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    try:
        payload = json.loads(result.stdout[result.stdout.index("{"): result.stdout.rindex("}") + 1])
    except ValueError:
        payload = {"raw": result.stdout + result.stderr}
    return result.returncode, payload


class PackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="handoff-test-"))

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fake_binary_with_secret_like_bytes_is_not_refused(self) -> None:
        workspace = self.tmp / "ws1"
        (workspace / "src").mkdir(parents=True)
        (workspace / "src" / "main.js").write_text("console.log(1)\n", encoding="utf-8")
        blob = b"\x00\x01token = 'aaaaaaaaaaaaaaaa'\x00\x02" * 10
        (workspace / "fake.exe").write_bytes(blob)
        code, payload = pack(workspace, self.tmp / "b1.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertIn("bundle", payload)
        self.assertGreaterEqual(payload["fileCount"], 1)

    def test_real_credential_is_still_refused(self) -> None:
        workspace = self.tmp / "ws2"
        workspace.mkdir()
        (workspace / "config.py").write_text('api_key = "sk-' + "a" * 30 + '"\n', encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b2.tar.gz")
        self.assertEqual(code, 1, payload)
        self.assertIn("possible secrets", payload["error"])
        self.assertIn("config.py", payload["files"])

    def test_nested_dirs_have_no_duplicate_entries(self) -> None:
        workspace = self.tmp / "ws3"
        (workspace / "a" / "b" / "c").mkdir(parents=True)
        for rel in ["a/one.txt", "a/b/two.txt", "a/b/c/three.txt"]:
            (workspace / rel).write_text("x\n", encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b3.tar.gz")
        self.assertEqual(code, 0, payload)
        with tarfile.open(self.tmp / "b3.tar.gz") as tar:
            names = tar.getnames()
        self.assertEqual(len(names), len(set(names)), names)
        self.assertEqual(sorted(n for n in names if n.startswith("workspace/")),
                         ["workspace/a/b/c/three.txt", "workspace/a/b/two.txt", "workspace/a/one.txt"])

    def test_large_binary_is_counted_not_silently_skipped(self) -> None:
        workspace = self.tmp / "ws4"
        workspace.mkdir()
        (workspace / "big.bin").write_bytes(b"\x00" * (2 * 1024 * 1024 + 10))
        code, payload = pack(workspace, self.tmp / "b4.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertGreaterEqual(payload["skippedLargeFiles"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
