import importlib.util
import fcntl
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("codex_apparmor", Path(__file__).with_name("codex-apparmor.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

BINARY = "/opt/foundry-worker/providers/codex-0.166.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap"
POLICY = '''abi <abi/5.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(attach_disconnected,mediate_deleted) {
  allow capability,
  allow userns,
  allow pix /** -> &bwrap//&unpriv_bwrap,
}
profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {
  allow userns,
  allow pix /** -> &unpriv_bwrap,
  audit deny capability,
}
'''


class CodexAppArmorTests(unittest.TestCase):
    def fixture(self, root):
        binary = root / BINARY.lstrip("/")
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"fixture executable")
        binary.chmod(0o755)
        source = root / "etc/apparmor.d/bwrap-userns-restrict"
        source.parent.mkdir(parents=True)
        source.write_text(POLICY)
        source.chmod(0o644)
        for entry in root.rglob("*"):
            if entry.is_dir():
                entry.chmod(0o755)
        return binary, source

    def test_preserves_distro_stacking_and_removes_only_own_unchanged_profile(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(helper, "ROOT_UID", os.getuid()), patch.object(helper, "validate_profile"):
            root = Path(directory)
            _, source = self.fixture(root)
            target = helper.install(root, BINARY)
            generated = target.read_text()
            self.assertIn('"' + BINARY + '"', generated)
            self.assertIn("audit deny capability,", generated)
            self.assertNotIn("profile bwrap ", generated)
            self.assertNotIn("profile unpriv_bwrap ", generated)
            self.assertNotIn("-> &bwrap", generated)
            self.assertNotIn("unconfined", generated)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(helper.install(root, BINARY), target)
            original = generated
            target.write_text(generated + "# external edit\n")
            with self.assertRaises(ValueError):
                helper.remove(root, BINARY)
            target.write_text(original)
            helper.remove(root, BINARY)
            self.assertFalse(target.exists())
            self.assertEqual(source.read_text(), POLICY)

    def test_rejects_untrusted_binary_paths_and_unrecognized_policy_before_writing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(helper, "ROOT_UID", os.getuid()), patch.object(helper, "validate_profile"):
            root = Path(directory)
            binary, source = self.fixture(root)
            for target in ["/usr/bin/bwrap", BINARY.replace("codex-0.166.0", "../other"), BINARY + '"']:
                with self.assertRaises(ValueError):
                    helper.install(root, target)
            for target in [binary, binary.parent, source]:
                original = target.stat().st_mode & 0o777
                target.chmod(original | 0o020)
                with self.assertRaises(ValueError):
                    helper.install(root, BINARY)
                target.chmod(original)
            binary.unlink()
            binary.symlink_to(source)
            with self.assertRaises(ValueError):
                helper.install(root, BINARY)
            binary.unlink()
            binary.write_bytes(b"fixture executable")
            binary.chmod(0o755)
            source.write_text(POLICY.replace("audit deny capability,", "allow capability,"))
            with self.assertRaises(ValueError):
                helper.install(root, BINARY)
            self.assertEqual(list(source.parent.glob("foundry-codex-bwrap-*")), [])
            source.write_text(POLICY)
            with patch.object(helper, "ROOT_UID", os.getuid() + 1):
                with self.assertRaises(ValueError):
                    helper.install(root, BINARY)
            with patch.object(helper, "validate_profile", side_effect=subprocess.CalledProcessError(1, "apparmor_parser")):
                with self.assertRaises(subprocess.CalledProcessError):
                    helper.install(root, BINARY)
            self.assertEqual(list(source.parent.glob("foundry-codex-bwrap-*")), [])


    def test_busy_deployment_lock_stops_before_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "lock"
            lock.touch()
            with lock.open("r+") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(helper.os, "geteuid", return_value=0), \
                     patch.object(helper, "trusted", return_value=lock), \
                     patch("sys.argv", ["codex-apparmor.py", "install", "--binary", BINARY]):
                    with self.assertRaisesRegex(SystemExit, "deployment lock is busy"):
                        helper.main()
            self.assertEqual(list(Path(directory).iterdir()), [lock])


if __name__ == "__main__":
    unittest.main()
