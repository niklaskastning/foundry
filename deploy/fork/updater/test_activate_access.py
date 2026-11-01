import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activate', Path(__file__).with_name('activate-access.py'))
activate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activate)
DIGEST = 'sha256:' + 'a' * 64
REVISION = 'b' * 40


def main_container():
    return {
        'Image': 'old-image', 'State': {'Running': True},
        'Config': {'Labels': {'com.docker.compose.project': 'foundry',
                              'com.docker.compose.service': 'main'}, 'Env': []},
        'Mounts': [{'Destination': '/var/lib/foundry', 'Type': 'volume', 'Name': 'foundry_foundry-state'},
                   {'Destination': '/workspaces', 'Type': 'volume', 'Name': 'foundry_foundry-workspaces'}],
        'HostConfig': {'PortBindings': {'3773/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3783'}]}},
        'NetworkSettings': {'Networks': {'foundry_default': {}}},
    }


class ActivationTest(unittest.TestCase):
    def test_active_status_is_read_only_and_rejects_drift_without_disclosing_secrets(self):
        for drift in [None, 'environment', 'compose', 'schema', 'identity', 'migrator', 'permissions']:
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                config = Path(directory)
                runtime = config / 'access-runtime.env'
                secret = 'a' * 64
                values = {
                    'FOUNDRY_INSTANCE_STORE': 'postgres', 'FOUNDRY_ACCESS_ENABLED': 'true',
                    'FOUNDRY_INSTANCE_DATABASE_URL': f'postgresql://foundry_instance_runtime:{secret}@postgres:5432/fork_connect',
                    'FOUNDRY_ACCESS_ISSUER': activate.ISSUER, 'FOUNDRY_ACCESS_AUDIENCE': secret,
                    'FOUNDRY_PUBLIC_ORIGIN': activate.ORIGIN,
                }
                runtime.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
                runtime.chmod(0o644 if drift == 'permissions' else 0o600)
                configured = activate.composition(activate.REGISTRY + '@' + DIGEST, runtime)
                if drift == 'compose':
                    configured['services']['main']['ports'] = ['0.0.0.0:3783:3773']
                compose = config / 'access-compose.json'
                compose.write_text(json.dumps(configured))
                compose.chmod(0o600)
                current = main_container()
                current['Config']['Env'] = [f'{key}={value}' for key, value in values.items()]
                if drift == 'environment':
                    current['Config']['Env'].append('UNKNOWN=secret')
                image = {'Id': current['Image'], 'Config': {'Env': [], 'Labels': {
                    'org.opencontainers.image.source': activate.SOURCE,
                    'org.opencontainers.image.revision': REVISION}}}
                postgres = main_container()
                postgres['Config']['Labels']['com.docker.compose.service'] = 'postgres'
                postgres['Mounts'] = [{'Destination': '/var/lib/postgresql/data', 'Type': 'volume',
                                       'Name': 'foundry_foundry-postgres'}]
                postgres['HostConfig']['PortBindings'] = {}
                calls = []

                def docker(*args, **kwargs):
                    calls.append(args)
                    self.assertIn(args[:2], [('container', 'inspect'), ('image', 'inspect')])
                    return json.dumps([image if args[0] == 'image' else
                                       current if args[2] == activate.MAIN else postgres])

                def sql(statement):
                    self.assertTrue(statement.startswith('BEGIN READ ONLY;'))
                    return json.dumps({'version': 5 if drift == 'schema' else 2,
                        'instanceId': 'wrong' if drift == 'identity' else activate.INSTANCE,
                        'environmentId': activate.ENVIRONMENT, 'operatorBound': True,
                        'runtimeLogin': True, 'migratorLogin': drift == 'migrator'})

                def metadata(path):
                    return {'instanceId': activate.INSTANCE, 'mainEnvironmentId': activate.ENVIRONMENT,
                            'environmentId': activate.ENVIRONMENT, 'ready': True,
                            'capabilities': ['foundry.access-sessions']}

                lstat = Path.lstat

                def owned(path):
                    fields = list(lstat(path))
                    fields[4] = 0
                    return os.stat_result(fields)

                with patch.object(activate, 'CONFIG', config), patch.object(activate, 'docker', docker), \
                     patch.object(activate, 'sql', sql), patch.object(activate, 'metadata', metadata), \
                     patch.object(Path, 'lstat', owned):
                    if drift:
                        with self.assertRaises(RuntimeError) as error:
                            activate.active_status()
                        self.assertNotIn(secret, str(error.exception))
                    else:
                        report = activate.active_status()
                        self.assertEqual(report['revision'], REVISION)
                        self.assertFalse(report['upgradePerformed'])
                        self.assertNotIn(secret, json.dumps(report).replace(DIGEST, 'digest'))
                self.assertTrue(calls)

    def test_rejects_wrong_targets_identity_and_nonempty_database(self):
        changes = [
            lambda c: c['Config']['Labels'].update({'com.docker.compose.project': 'other'}),
            lambda c: c['Mounts'][0].update({'Type': 'bind', 'Source': '/home/user/.t3'}),
            lambda c: c['HostConfig']['PortBindings']['3773/tcp'][0].update({'HostIp': '0.0.0.0'}),
            lambda c: c['NetworkSettings']['Networks'].update({'other': {}}),
            lambda c: c['Config']['Env'].append('FOUNDRY_INSTANCE_STORE=postgres'),
            lambda c: c['Config']['Env'].append('CUSTOM=1'),
        ]
        with patch.object(activate, 'docker', return_value=json.dumps([{'Config': {'Env': []}}])):
            activate.check_main(main_container())
            for change in changes:
                value = main_container()
                change(value)
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    activate.check_main(value)
        with self.assertRaises(RuntimeError):
            activate.check_identity({'instanceId': 'other'}, {'environmentId': activate.ENVIRONMENT})
        empty = {'owner': 'foundry_connect_owner', 'ownerLogin': False, 'version': 170009,
                 'schemas': 0, 'objects': 0, 'roles': 0, 'connections': 0}
        with patch.object(activate, 'sql', return_value=json.dumps(empty)):
            activate.check_empty_database()
        for key, value in [('owner', 'other'), ('ownerLogin', True), ('version', 160000),
                           ('schemas', 1), ('objects', 1), ('roles', 1), ('connections', 1)]:
            with self.subTest(key=key), patch.object(activate, 'sql', return_value=json.dumps({**empty, key: value})), \
                 self.assertRaises(RuntimeError):
                activate.check_empty_database()
        postgres = main_container()
        postgres['Config']['Labels']['com.docker.compose.service'] = 'postgres'
        postgres['Mounts'] = [{'Destination': '/var/lib/postgresql/data', 'Type': 'volume', 'Name': 'foundry_foundry-postgres'}]
        postgres['HostConfig']['PortBindings'] = {}
        activate.check_postgres(postgres)
        postgres['HostConfig']['PortBindings'] = {'5432/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '5432'}]}
        with self.assertRaises(RuntimeError):
            activate.check_postgres(postgres)

    def test_activation_orders_backup_migration_and_verification_and_stops_on_failure(self):
        for failure in [None, 'source', 'backup', 'roles', 'migrate', 'bind', 'start', 'identity', 'capability']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config, state = root / 'config', root / 'state'
                config.mkdir()
                state.mkdir()
                (config / 'compose.yml').write_text('baseline')
                current = main_container()
                actions = []
                candidate = {'Id': 'new-image', 'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Labels': {
                    'org.opencontainers.image.source': 'other' if failure == 'source' else activate.SOURCE,
                    'org.opencontainers.image.revision': REVISION}}}

                def docker(*args, data=None, output=None):
                    actions.append(args)
                    if args[:2] == ('image', 'inspect'):
                        return json.dumps([candidate])
                    if args[:2] == ('container', 'inspect'):
                        return json.dumps([current])
                    if args[0] == 'stop':
                        current['State']['Running'] = False
                    if args[0] == 'start':
                        current['State']['Running'] = True
                    if output is not None:
                        self.assertFalse(current['State']['Running'])
                        if failure == 'backup':
                            raise RuntimeError('backup failed')
                        output.write(b'isolated backup fixture')
                    if args[0] == 'compose':
                        self.assertIn('--no-deps', args)
                        self.assertEqual(args[-1], 'main')
                        current['Image'] = 'new-image'
                        current['State']['Running'] = True
                        if failure == 'start':
                            raise RuntimeError('startup failed')
                    if args[0] == 'run':
                        self.assertFalse(current['State']['Running'])
                        if (failure == 'migrate' and 'migrate' in args) or (failure == 'bind' and 'bind-operator' in args):
                            raise RuntimeError('CLI failed')
                    return ''

                def sql(statement):
                    actions.append(('sql', statement))
                    self.assertFalse(current['State']['Running'])
                    self.assertTrue(next(state.iterdir()).joinpath('fork_connect.dump').exists())
                    if failure == 'roles':
                        raise RuntimeError('roles failed')
                    return ''

                def metadata(path):
                    if path.startswith('/.well-known/foundry'):
                        return {'instanceId': 'other' if failure == 'identity' else activate.INSTANCE,
                                'mainEnvironmentId': activate.ENVIRONMENT,
                                'capabilities': [] if failure == 'capability' else ['foundry.access-sessions']}
                    if 'environment' in path:
                        return {'environmentId': activate.ENVIRONMENT}
                    return {'ready': True}

                with patch.object(activate, 'CONFIG', config), patch.object(activate, 'STATE', state), \
                     patch.object(activate, 'private_json', return_value={'audience': 'c' * 64, 'subject': 'confirmed-subject'}), \
                     patch.object(activate, 'preflight', return_value=copy.deepcopy(current)), \
                     patch.object(activate, 'check_empty_database'), patch.object(activate, 'docker', docker), \
                     patch.object(activate, 'sql', sql), patch.object(activate, 'metadata', metadata), \
                     patch('sys.stdout', io.StringIO()), patch('sys.stderr', io.StringIO()):
                    if failure:
                        with self.assertRaises(RuntimeError):
                            activate.activate(DIGEST, REVISION)
                    else:
                        activate.activate(DIGEST, REVISION)
                self.assertEqual(current['State']['Running'], failure in [None, 'source', 'backup'])
                if failure == 'source':
                    self.assertEqual(list(state.iterdir()), [])
                    self.assertFalse(any(a[0] == 'stop' for a in actions))
                elif failure != 'backup':
                    backup = next(state.iterdir())
                    self.assertTrue((backup / 'roles.sql').exists())
                    self.assertEqual((backup / 'success').exists(), failure is None)
                    runtime = (config / 'access-runtime.env').read_text()
                    self.assertNotIn('MIGRATION_URL', runtime)
                    self.assertNotIn('foundry_admin', runtime)
                    if failure is None:
                        compose = json.loads((config / 'access-compose.json').read_text())
                        self.assertEqual(list(compose['services']), ['main'])
                        self.assertEqual(compose['services']['main']['image'], activate.REGISTRY + '@' + DIGEST)
                        self.assertTrue(any(a[0] == 'sql' and 'NOLOGIN' in a[1] for a in actions))
                if failure not in [None, 'source', 'backup']:
                    self.assertFalse(any(a[0] == 'start' for a in actions))

    def test_credentials_and_host_environment_are_not_exposed_on_subprocess_failure(self):
        result = type('Result', (), {'returncode': 1, 'stdout': b'', 'stderr': b'password=secret'})()
        with patch.object(activate.subprocess, 'run', return_value=result) as run, \
             patch.dict('os.environ', {'DOCKER_HOST': 'tcp://other', 'COMPOSE_FILE': '/tmp/other'}):
            with self.assertRaises(RuntimeError) as error:
                activate.docker('exec', '-i', activate.POSTGRES, data=b'private SQL')
        self.assertNotIn('secret', str(error.exception))
        self.assertEqual(run.call_args.kwargs['env'], activate.ENV)
        self.assertEqual(run.call_args.args[0][1:3], ['--host', 'unix:///var/run/docker.sock'])

    def test_invalid_arguments_cannot_reach_docker(self):
        with patch.object(activate, 'docker') as docker:
            for args in [['activate'], ['activate', DIGEST, REVISION, 'extra'], ['restore'], ['preflight', 'extra']]:
                with self.assertRaises(ValueError):
                    activate.main(args)
            for digest, revision in [('latest', REVISION), (DIGEST, 'main'), (DIGEST + '; command', REVISION)]:
                with self.assertRaises(ValueError):
                    activate.activate(digest, revision)
            docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
