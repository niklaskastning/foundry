import importlib.util
import json
from pathlib import Path
import subprocess
import sqlite3
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


inspection_spec = importlib.util.spec_from_file_location("foundry_g3_inspection", Path(__file__).with_name("inspect-g3.py"))
inspection = importlib.util.module_from_spec(inspection_spec)
inspection_spec.loader.exec_module(inspection)


binding_spec = importlib.util.spec_from_file_location("foundry_g3_binding", Path(__file__).with_name("bind-codex-g3.py"))
binding = importlib.util.module_from_spec(binding_spec)
binding_spec.loader.exec_module(binding)


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
            manifest = installation.path(worker.MANIFEST)
            previous = json.loads(manifest.read_text())
            previous["units"]["foundry-host.service"] = previous["units"]["foundry-host.service"].replace("Description=Foundry isolated T3 host", "Description=Previous installer template")
            installation.path(worker.UNITS + "/foundry-host.service").write_text(previous["units"]["foundry-host.service"])
            manifest.write_text(json.dumps(previous))
            settings["revision"] = "b" * 40
            settings["memoryMaxMiB"] = 2048
            settings["providerInstanceId"] = "codex-worker"
            release(installation, settings)
            original_write = installation.write
            def fail_once(name, text, mode):
                if name.endswith("foundry-connector.service") and "b" * 40 in text:
                    raise OSError("injected disk failure")
                original_write(name, text, mode)
            with patch.object(installation, "write", side_effect=fail_once), self.assertRaises(OSError):
                installation.install(settings)
            self.assertIn("a" * 40, installation.path(worker.UNITS + "/foundry-host.service").read_text())
            self.assertIn("Description=Previous installer template", installation.path(worker.UNITS + "/foundry-host.service").read_text())
            installation.install(settings)
            installation.install(settings)
            self.assertEqual(json.loads(manifest.read_text())["config"]["providerInstanceId"], "codex-worker")
            self.assertIn("FOUNDRY_WORKER_PROVIDER_INSTANCE_ID=codex-worker", installation.path(worker.UNITS + "/foundry-host.service").read_text())
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
        for field, value in [("providerInstanceId", "codex\nExecStart=/bin/sh"), ("providerInstanceId", "1invalid"), ("node", "/home/person/node"), ("node", "/usr/bin/node\nExecStart=/bin/sh"), ("origin", "https://main.example/path"), ("origin", "https://user:secret@main.example"), ("origin", "https://main.example%20"), ("revision", "../personal"), ("workspaceRoots", ["/home/person"]), ("workspaceRoots", [worker.WORKSPACES + "/../private"]), ("memoryMaxMiB", 0), ("tasksMax", True), ("accessFile", "yes")]:
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

    def test_g3_inventory_is_offline_read_only_and_never_claims_provider_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            installation = worker.Installation(directory)
            settings = config()
            release(installation, settings)
            node = installation.path(settings["node"])
            node.parent.mkdir(parents=True)
            node.write_text("fixture")
            for path in (node, installation.path(worker.release(settings) + "/dist/bin.mjs")):
                path.chmod(0o644)
            for path in (installation.path(worker.release(settings)), installation.path(worker.release(settings) + "/dist")):
                path.chmod(0o755)
            installation.install(settings)
            secret = installation.path(worker.STATE + "/device-key.json")
            secret.write_text("private-must-not-appear")
            before = {p: p.read_bytes() for p in Path(directory).rglob("*") if p.is_file()}
            with patch.object(inspection, "command", side_effect=AssertionError("No command offline")), patch.object(inspection.urllib.request, "build_opener", side_effect=AssertionError("No HTTP offline")):
                report = inspection.inventory(directory)
            self.assertIsNone(report["providerReady"])
            self.assertIsNone(report["providerInstanceId"])
            self.assertFalse(report["g3Accepted"])
            self.assertFalse(report["runtimeVerifiedAsWorker"])
            self.assertTrue(report["offlineOnly"])
            self.assertNotIn("private-must-not-appear", json.dumps(report))
            self.assertEqual(before, {p: p.read_bytes() for p in Path(directory).rglob("*") if p.is_file()})
            settings["providerInstanceId"] = "codex-worker"
            installation.install(settings)
            self.assertIsNone(inspection.inventory(directory)["providerReady"])
            entry = installation.path(worker.release(settings) + "/dist/bin.mjs")
            entry.chmod(0o666)
            with self.assertRaises(RuntimeError):
                inspection.inventory(directory)
            entry.chmod(0o644)
            unit = installation.path(worker.UNITS + "/foundry-host.service")
            unit.write_text("external drift")
            with self.assertRaises(RuntimeError):
                inspection.inventory(directory)

    def test_codex_binding_refuses_active_unresolved_and_reserved_writers(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statev2.sqlite"
            with self.assertRaises(RuntimeError):
                binding.quiet_database(database)
            with sqlite3.connect(database) as connection:
                connection.executescript("CREATE TABLE orchestration_v2_projection_runs(status TEXT); CREATE TABLE foundry_executions(manifest TEXT);")
                connection.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('completed')")
            binding.quiet_database(database)
            for status in ("queued", "preparing", "running", "finalizing", "unknown"):
                with sqlite3.connect(database) as connection:
                    connection.execute("UPDATE orchestration_v2_projection_runs SET status=?", (status,))
                with self.subTest(status=status), self.assertRaises(RuntimeError):
                    binding.quiet_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE orchestration_v2_projection_runs SET status='completed'")
                connection.execute("INSERT INTO foundry_executions VALUES (NULL)")
            with self.assertRaises(RuntimeError):
                binding.quiet_database(database)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE foundry_executions SET manifest='confirmed'")
            journal = database.with_name("foundry-workspaces.sqlite")
            with sqlite3.connect(journal) as connection:
                connection.execute("CREATE TABLE reservations(state TEXT)")
                connection.execute("INSERT INTO reservations VALUES ('ready')")
            with self.assertRaises(RuntimeError):
                binding.quiet_database(database)
            with sqlite3.connect(journal) as connection:
                connection.execute("UPDATE reservations SET state='released'")
            binding.quiet_database(database)

    def test_persisted_acceptance_requires_exact_attempt_and_checkpoint_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statev2.sqlite"
            manifest = {"generation": 2, "runId": "run", "checkpointId": "checkpoint", "checkpointRef": "ref", "outcome": "completed"}
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE foundry_executions(command_id TEXT,thread_id TEXT,generation INTEGER,writer_ended INTEGER,manifest TEXT)")
                connection.execute("INSERT INTO foundry_executions VALUES ('command','thread',2,1,?)", (json.dumps(manifest),))
                for table in ("threads", "runs", "run_attempts", "provider_turns"):
                    connection.execute(f"CREATE TABLE orchestration_v2_projection_{table}(thread_id TEXT)")
                    connection.execute(f"INSERT INTO orchestration_v2_projection_{table} VALUES ('thread')")
                connection.execute("CREATE TABLE orchestration_v2_projection_checkpoints(checkpoint_id TEXT,thread_id TEXT,run_id TEXT,status TEXT)")
                connection.execute("INSERT INTO orchestration_v2_projection_checkpoints VALUES ('checkpoint','thread','run','ready')")
            receipt = {"threadId": "thread"}
            self.assertEqual(binding.persisted_acceptance(database, "command", receipt, manifest), manifest)
            with sqlite3.connect(database) as connection:
                connection.execute("INSERT INTO orchestration_v2_projection_run_attempts VALUES ('thread')")
            with self.assertRaises(RuntimeError):
                binding.persisted_acceptance(database, "command", receipt, manifest)
            with sqlite3.connect(database) as connection:
                connection.execute("DELETE FROM orchestration_v2_projection_run_attempts WHERE rowid=2")
                connection.execute("UPDATE orchestration_v2_projection_checkpoints SET run_id='other-run'")
            with self.assertRaises(RuntimeError):
                binding.persisted_acceptance(database, "command", receipt, manifest)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE orchestration_v2_projection_checkpoints SET run_id='run'")
                connection.execute("UPDATE foundry_executions SET writer_ended=0")
            with self.assertRaises(RuntimeError):
                binding.persisted_acceptance(database, "command", receipt, manifest)

    def test_active_restart_requires_held_reservation_until_positive_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "statev2.sqlite"
            journal = Path(directory) / "foundry-workspaces.sqlite"
            record = {"launch": {"commandId": "command"}, "receipt": {"threadId": "thread"}, "generation": 4}
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE foundry_executions(command_id TEXT,thread_id TEXT,generation INTEGER,state TEXT,writer_ended INTEGER,manifest TEXT)")
                connection.execute("INSERT INTO foundry_executions VALUES ('command','thread',4,'uncertain',0,NULL)")
                for table in ("runs", "run_attempts", "provider_turns"):
                    connection.execute(f"CREATE TABLE orchestration_v2_projection_{table}(thread_id TEXT,run_id TEXT)")
                    connection.execute(f"INSERT INTO orchestration_v2_projection_{table} VALUES ('thread','run')")
            with sqlite3.connect(journal) as connection:
                connection.executescript("CREATE TABLE reservations(request_id TEXT,state TEXT); CREATE TABLE writer_bindings(request_id TEXT,command_id TEXT,thread_id TEXT,generation INTEGER); INSERT INTO reservations VALUES ('reservation','ready'); INSERT INTO writer_bindings VALUES ('reservation','command','thread',4);")
            proof = binding.validate_restart_state(database, journal, record)
            self.assertTrue(proof["reservationHeld"])
            self.assertFalse(proof["writerEnded"])
            with sqlite3.connect(journal) as connection:
                connection.execute("UPDATE reservations SET state='released'")
            with self.assertRaises(RuntimeError):
                binding.validate_restart_state(database, journal, record)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE foundry_executions SET state='stopped',writer_ended=1,manifest=?", (json.dumps({"generation": 4, "runId": "run", "outcome": "stopped"}),))
            self.assertFalse(binding.validate_restart_state(database, journal, record)["reservationHeld"])
            with sqlite3.connect(database) as connection:
                connection.execute("INSERT INTO orchestration_v2_projection_run_attempts VALUES ('thread','run')")
            with self.assertRaises(RuntimeError):
                binding.validate_restart_state(database, journal, record)

    def test_native_restart_wait_requires_real_provider_command_milestone(self):
        result = subprocess.run(["node", "deploy/fork/worker/test-g3-native-wait.mjs"], cwd=Path(__file__).resolve().parents[3], input=binding.RPC_NATIVE, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_acceptance_transport_retries_and_rejects_wrong_generation(self):
        result = subprocess.run(["node", "deploy/fork/worker/test-g3-transport.mjs"], cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

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
