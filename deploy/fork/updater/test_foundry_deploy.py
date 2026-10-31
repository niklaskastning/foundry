import copy
import fcntl
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("foundry_deploy", Path(__file__).with_name("foundry-deploy.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
DIGEST = "sha256:" + "a" * 64
REVISION = "b" * 40


def container():
    return {
        "Image": "old-image", "State": {"Running": True, "Status": "running"},
        "Config": {"Labels": {"com.docker.compose.project": "foundry",
                              "com.docker.compose.service": "main"}, "Env": []},
        "Mounts": [{"Destination": "/var/lib/foundry", "Type": "volume", "Name": "foundry_foundry-state"},
                   {"Destination": "/workspaces", "Type": "volume", "Name": "foundry_foundry-workspaces"}],
        "HostConfig": {"PortBindings": {"3773/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3783"}]}},
        "NetworkSettings": {"Networks": {"foundry_default": {}}},
    }


class DeploymentTest(unittest.TestCase):
    def test_rejects_arguments_and_other_deployments_before_mutation(self):
        with patch.object(updater, "docker") as docker:
            for value in ["latest", "sha256:short", DIGEST + " --privileged", "/tmp/image.tar"]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    updater.deploy(value)
            for args in [["run", "alpine"], ["deploy", DIGEST, "extra"], ["status", "extra"]]:
                with self.subTest(args=args), self.assertRaises(ValueError):
                    updater.main(args)
            docker.assert_not_called()
        changes = [
            lambda c: c["Config"]["Labels"].update({"com.docker.compose.project": "kubernetes"}),
            lambda c: c["Mounts"][0].update({"Type": "bind", "Source": "/"}),
            lambda c: c["HostConfig"]["PortBindings"]["3773/tcp"][0].update({"HostIp": "0.0.0.0"}),
            lambda c: c["NetworkSettings"]["Networks"].update({"another-project": {}}),
            lambda c: c["Config"]["Env"].append("FOUNDRY_INSTANCE_STORE=postgres"),
        ]
        for change in changes:
            existing = container()
            change(existing)
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                updater.validate_target(existing)

    def test_update_preserves_identity_and_handles_failures_before_and_after_start(self):
        for failure in [None, "source", "backup", "start", "identity"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                current = container()
                actions = []
                candidate = {"Id": "new-image", "Os": "linux", "Architecture": "amd64", "Config": {
                    "Labels": {"org.opencontainers.image.source": updater.SOURCE if failure != "source" else "other",
                               "org.opencontainers.image.revision": REVISION}}}

                def docker(*args, image=None, output=None):
                    actions.append(args[0])
                    if args[:2] == ("container", "inspect"):
                        return json.dumps([copy.deepcopy(current)])
                    if args == ("image", "inspect", "old-image"):
                        return json.dumps([{"Config": {"Env": []}}])
                    if args[:2] == ("image", "inspect"):
                        return json.dumps([candidate])
                    if args[0] == "stop":
                        current["State"]["Running"] = False
                    if args[0] == "start":
                        current["State"]["Running"] = True
                    if args[0] == "cp":
                        self.assertFalse(current["State"]["Running"])
                        if failure == "backup":
                            raise RuntimeError("Backup failed")
                        output.write(b"state archive fixture")
                    if args[0] == "compose":
                        self.assertIn("--no-deps", args)
                        self.assertIn("--no-build", args)
                        self.assertNotIn("--remove-orphans", args)
                        self.assertEqual(args[-1], "main")
                        self.assertEqual(image, f"{updater.REGISTRY}@{DIGEST}")
                        current["Image"] = "new-image"
                        current["State"]["Running"] = True
                        if failure == "start":
                            raise RuntimeError("Unhealthy candidate")
                    return ""

                def metadata(path, optional=False):
                    if "environment" in path:
                        return {"environmentId": "environment"}
                    if "well-known/foundry" in path:
                        return {"instanceId": "changed" if failure == "identity" and current["Image"] == "new-image" else "instance"}
                    return {"ready": True}

                with patch.object(updater, "STATE", Path(directory)), patch.object(updater, "docker", docker), \
                     patch.object(updater, "metadata", metadata), patch("sys.stdout", io.StringIO()), \
                     patch("sys.stderr", io.StringIO()):
                    if failure:
                        with self.assertRaises(RuntimeError):
                            updater.deploy(DIGEST)
                    else:
                        updater.deploy(DIGEST)
                self.assertEqual(current["State"]["Running"], failure not in ["start", "identity"])
                if failure in ["source", "backup"]:
                    self.assertEqual(current["Image"], "old-image")
                    self.assertNotIn("compose", actions)
                else:
                    backup = next(Path(directory).iterdir())
                    self.assertEqual((backup / "state.tar").read_bytes(), b"state archive fixture")
                    self.assertEqual(json.loads((backup / "manifest.json").read_text())["previousImage"], "old-image")
                    self.assertEqual((backup / "success").exists(), failure is None)
                    self.assertNotIn("start", actions)

    def test_docker_does_not_inherit_caller_environment_or_shell(self):
        result = type("Result", (), {"returncode": 0, "stdout": b"ok", "stderr": b""})()
        with patch.dict("os.environ", {"DOCKER_HOST": "tcp://elsewhere", "COMPOSE_FILE": "/tmp/evil.yml", "PATH": "/tmp"}), \
             patch.object(updater.subprocess, "run", return_value=result) as run:
            updater.docker("pull", f"{updater.REGISTRY}@{DIGEST}")
        command = run.call_args.args[0]
        options = run.call_args.kwargs
        self.assertEqual(command[:3], ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"])
        self.assertNotIn("DOCKER_HOST", options["env"])
        self.assertNotIn("COMPOSE_FILE", options["env"])
        self.assertEqual(options["cwd"], "/")
        self.assertFalse(options.get("shell", False))

    def test_concurrent_deployment_cannot_enter_the_docker_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / "lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(updater, "STATE", Path(directory)), \
                     patch.object(updater.os, "geteuid", return_value=0), \
                     patch.object(updater.os, "umask"), patch.object(updater, "docker") as docker:
                    with self.assertRaises(BlockingIOError):
                        updater.main(["deploy", DIGEST])
                    docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
