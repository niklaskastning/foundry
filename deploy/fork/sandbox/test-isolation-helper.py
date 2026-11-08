#!/usr/bin/python3
"""Offline fail-closed checks for the root-only host-policy verifier."""
import importlib.util
from pathlib import Path
import stat
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('isolation_policy', Path(__file__).with_name('isolation-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class IsolationPolicyTests(unittest.TestCase):
    def test_rejects_writable_nonroot_symlink_and_nonregular_policy(self):
        target = Path('/usr/local/lib/foundry/sandbox/codex-seccomp-v1.json')
        for uid, mode in [(1000, stat.S_IFREG | 0o644),
                          (0, stat.S_IFREG | 0o664),
                          (0, stat.S_IFLNK | 0o777),
                          (0, stat.S_IFDIR | 0o755)]:
            with self.subTest(uid=uid, mode=mode):
                def info(candidate):
                    if candidate == target:
                        return types.SimpleNamespace(st_uid=uid, st_mode=mode)
                    return types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
                with patch.object(Path, 'lstat', info), self.assertRaises(RuntimeError):
                    policy.trusted(target)

    def test_rejects_changed_profile_bytes(self):
        original = Path.read_bytes
        def contents(path):
            if path.name == 'codex-seccomp-v1.json':
                return b'{"defaultAction":"SCMP_ACT_ALLOW"}'
            return original(path)
        with patch.object(policy, '__file__', str(policy.DIRECTORY / 'isolation-policy.py')), \
                patch.object(policy, 'trusted'), patch.object(Path, 'read_bytes', contents), \
                self.assertRaisesRegex(RuntimeError, 'content mismatch'):
            policy.verify_files()

    def test_checked_in_profiles_match_compiled_hashes(self):
        import hashlib
        for name, expected in policy.EXPECTED.items():
            self.assertEqual(hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest(), expected)


if __name__ == '__main__':
    unittest.main()
