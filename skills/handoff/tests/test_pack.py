#!/usr/bin/env python3
"""Offline tests for handoff pack: secret scan scope, large files, duplicate entries.

Run: python skills/handoff/tests/test_pack.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "handoff.py"
MB = 1024 * 1024


def pack(workspace: Path, out: Path, *extra: str) -> tuple[int, dict]:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "pack", "--workspace", str(workspace), "--out", str(out), *extra],
        capture_output=True,
        text=True,
    )
    try:
        payload = json.loads(result.stdout[result.stdout.index("{"): result.stdout.rindex("}") + 1])
    except ValueError:
        payload = {"raw": result.stdout + result.stderr}
    return result.returncode, payload


def bundle_names(bundle: Path) -> list[str]:
    with tarfile.open(bundle) as tar:
        return tar.getnames()


class PackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="handoff-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fake_binary_with_secret_like_bytes_is_not_refused(self) -> None:
        workspace = self.tmp / "ws1"
        (workspace / "src").mkdir(parents=True)
        (workspace / "src" / "main.js").write_text("console.log(1)\n", encoding="utf-8")
        (workspace / "fake.exe").write_bytes(b"\x00\x01token = 'aaaaaaaaaaaaaaaa'\x00\x02" * 10)  # pragma: allowlist secret
        code, payload = pack(workspace, self.tmp / "b1.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertIn("bundle", payload)

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
        names = bundle_names(self.tmp / "b3.tar.gz")
        self.assertEqual(len(names), len(set(names)), names)
        self.assertEqual(
            sorted(name for name in names if name.startswith("workspace/")),
            ["workspace/a/b/c/three.txt", "workspace/a/b/two.txt", "workspace/a/one.txt"],
        )

    def test_large_binary_is_excluded_and_never_scanned_as_text(self) -> None:
        workspace = self.tmp / "ws4"
        workspace.mkdir()
        (workspace / "big.bin").write_bytes(b"\x00" * (3 * MB))
        code, payload = pack(workspace, self.tmp / "b4.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertGreaterEqual(payload["excludedBinaryFiles"], 1)
        self.assertNotIn("workspace/big.bin", bundle_names(self.tmp / "b4.tar.gz"))

    def test_large_text_with_secret_is_excluded_by_default(self) -> None:
        workspace = self.tmp / "ws5"
        workspace.mkdir()
        secret = 'api_key = "sk-' + "b" * 30 + '"\n'  # pragma: allowlist secret
        (workspace / "huge.txt").write_text(secret + "padding line\n" * 250_000, encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b5.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["excludedLargeFiles"], 1)
        self.assertIn("huge.txt", payload["excludedLargeSample"])
        self.assertNotIn("workspace/huge.txt", bundle_names(self.tmp / "b5.tar.gz"))
        self.assertFalse(payload["containsLargeFiles"])

    def test_allow_large_still_refuses_a_large_file_with_a_secret(self) -> None:
        workspace = self.tmp / "ws6"
        workspace.mkdir()
        secret = 'api_key = "sk-' + "c" * 30 + '"\n'  # pragma: allowlist secret
        (workspace / "huge.txt").write_text(secret + "padding line\n" * 250_000, encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b6.tar.gz", "--allow-large")
        self.assertEqual(code, 1, payload)
        self.assertIn("huge.txt", payload["files"])

    def test_allow_large_packs_a_clean_large_file_and_flags_it(self) -> None:
        workspace = self.tmp / "ws7"
        workspace.mkdir()
        (workspace / "clean.txt").write_text("plain line\n" * 300_000, encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b7.tar.gz", "--allow-large")
        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["containsLargeFiles"])
        self.assertIn("workspace/clean.txt", bundle_names(self.tmp / "b7.tar.gz"))

    def test_small_pack_reports_no_large_files(self) -> None:
        workspace = self.tmp / "ws8"
        workspace.mkdir()
        (workspace / "small.txt").write_text("hello\n", encoding="utf-8")
        code, payload = pack(workspace, self.tmp / "b8.tar.gz")
        self.assertEqual(code, 0, payload)
        self.assertFalse(payload["containsLargeFiles"])
        self.assertEqual(payload["excludedLargeFiles"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
