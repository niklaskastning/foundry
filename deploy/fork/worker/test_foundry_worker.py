import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("foundry_worker", Path(__file__).with_name("foundry-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def config():
    return {
        "revision": "a" * 40, "node": "/usr/bin/node", "origin": "https://main.example.test",
        "port": 3973, "workspaceRoots": [worker.WORKSPACES + "/projects"],
        "cpuQuotaPercent": 100, "memoryMaxMiB": 1024, "tasksMax": 128, "accessFile": False,
    }


def release(installation, settings):
    directory = installation.path(worker.release(settings) + "/dist")
    directory.mkdir(parents=True)
    (directory / "bin.mjs").write_text("// Isolated installer fixture; not a runtime acceptance test.\n")
    (directory / "foundry-build.json").write_text(json.dumps({"repository": "niklaskastning/foundry", "revision": settings["revision"], "dirty": False}))


class WorkerInstallationTest(unittest.TestCase):
    def test_install_upgrade_remove_preserve_identity_credentials_and_other_service(self):
        with tempfile.TemporaryDirectory() as directory:
            installation = worker.Installation(directory)
            settings = config()
            release(installation, settings)
            installation.install(settings)
            userdata = installation.path(worker.T3 + "/userdata")
            userdata.mkdir()
            identity = userdata / "environment-id"
            identity.write_text("isolated-worker-identity\n")
            credential = installation.path(worker.STATE + "/device-key.json")
            credential.write_text("private fixture")
            personal = installation.path(worker.UNITS + "/personal-t3.service")
            personal.write_text("personal service fixture")
            before = {p: p.read_bytes() for p in (identity, credential, personal)}
            settings["revision"] = "b" * 40
            settings["memoryMaxMiB"] = 2048
            release(installation, settings)
            original_write = installation.write
            def fail_once(name, text, mode):
                if name.endswith("foundry-connector.service") and "b" * 40 in text:
                    raise OSError("injected disk failure")
                original_write(name, text, mode)
            with patch.object(installation, "write", side_effect=fail_once), self.assertRaises(OSError):
                installation.install(settings)
            self.assertIn("a" * 40, installation.path(worker.UNITS + "/foundry-host.service").read_text())
            installation.install(settings)
            installation.install(settings)
            self.assertIn("MemoryMax=2048M", installation.path(worker.UNITS + "/foundry-host.slice").read_text())
            self.assertIn("b" * 40, installation.path(worker.UNITS + "/foundry-host.service").read_text())
            self.assertEqual(installation.path(worker.WORKER_HOME).stat().st_mode & 0o777, 0o700)
            self.assertEqual(installation.path(worker.MANIFEST).stat().st_mode & 0o777, 0o600)
            installation.remove()
            installation.remove()
            self.assertFalse(any(installation.path(worker.UNITS + "/" + name).exists() for name in worker.NAMES))
            self.assertEqual({p: p.read_bytes() for p in before}, before)
            installation.install(settings)
            self.assertEqual(identity.read_text(), "isolated-worker-identity\n")

    def test_refuses_path_injection_unowned_units_changed_bindings_and_dirty_releases(self):
        for field, value in [("node", "/home/person/node"), ("node", "/usr/bin/node\nExecStart=/bin/sh"), ("origin", "https://main.example/path"), ("origin", "https://user:secret@main.example"), ("origin", "https://main.example%20"), ("revision", "../personal"), ("workspaceRoots", ["/home/person"]), ("workspaceRoots", [worker.WORKSPACES + "/../private"]), ("memoryMaxMiB", 0), ("tasksMax", True), ("accessFile", "yes")]:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as directory:
                installation = worker.Installation(directory)
                invalid = {**config(), field: value}
                with self.assertRaises(ValueError):
                    installation.install(invalid)
                self.assertEqual(list(Path(directory).iterdir()), [])
        with tempfile.TemporaryDirectory() as directory:
            installation = worker.Installation(directory)
            settings = config()
            release(installation, settings)
            metadata = installation.path(worker.release(settings) + "/dist/foundry-build.json")
            original = metadata.read_text()
            metadata.write_text(original.replace('false', 'true'))
            with self.assertRaises(ValueError):
                installation.install(settings)
            metadata.write_text(original)
            installation.install(settings)
            for field, value in [("origin", "https://another.example"), ("port", 3999), ("workspaceRoots", [worker.WORKSPACES + "/other"])]:
                with self.subTest(field=field), self.assertRaises(ValueError):
                    installation.install({**settings, field: value})
            unit = installation.path(worker.UNITS + "/foundry-host.service")
            unit.write_text("external change")
            with self.assertRaises(RuntimeError):
                installation.install(settings)
            with self.assertRaises(RuntimeError):
                installation.remove()
            self.assertEqual(unit.read_text(), "external change")

    def test_refuses_symlinks_and_live_processes(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            installation = worker.Installation(directory)
            (Path(directory) / "etc").symlink_to(other, target_is_directory=True)
            with self.assertRaises(ValueError):
                installation.install(config())
            self.assertEqual(list(Path(other).iterdir()), [])
        with patch.object(worker.os, "geteuid", return_value=0), patch.object(worker.subprocess, "run") as run:
            installation = worker.Installation("/")
            for state in ("active", "activating", "deactivating", ""):
                run.return_value.stdout = state
                with self.subTest(state=state), self.assertRaises(RuntimeError):
                    installation.stopped()
            run.return_value.stdout = "inactive\n"
            installation.stopped()
            self.assertEqual(run.call_args.args[0][:2], ["systemctl", "show"])

    def test_systemd_accepts_units_with_shared_budget_and_explicit_runtime_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            installation = worker.Installation(directory)
            settings = config()
            settings["accessFile"] = True
            release(installation, settings)
            installation.install(settings)
            units = [str(installation.path(worker.UNITS + "/" + name)) for name in worker.NAMES]
            node = installation.path("/usr/bin/node")
            node.parent.mkdir(parents=True)
            node.write_text("#!/bin/sh\nexit 0\n")
            node.chmod(0o755)
            for name in ("sysinit.target", "basic.target", "shutdown.target", "network-online.target", "multi-user.target", "system.slice", "foundry.slice", "-.slice"):
                installation.path(worker.UNITS + "/" + name).write_text("[Unit]\nDescription=Isolated verifier dependency\nDefaultDependencies=no\n")
            result = subprocess.run(["systemd-analyze", "verify", "--root=" + directory, "--man=no", *[worker.UNITS + "/" + name for name in worker.NAMES]], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in ("foundry-host.service", "foundry-connector.service"):
                text = installation.path(worker.UNITS + "/" + name).read_text()
                self.assertIn("User=foundry-worker\n", text)
                self.assertIn("Slice=foundry-host.slice\n", text)
                self.assertIn("ProtectHome=true\n", text)
                self.assertIn("KillMode=control-group\n", text)
                self.assertIn("Environment=T3CODE_HOME=" + worker.T3, text)
                self.assertNotIn("--no-auth", text)
            self.assertIn("--access-file " + worker.STATE + "/access.json", Path(units[-1]).read_text())


if __name__ == "__main__":
    unittest.main()
