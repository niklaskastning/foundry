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
    def test_automation_profile_requires_separate_database_and_explicit_empty_admission(self):
        secret = 'a' * 64
        base = {
            'FOUNDRY_INSTANCE_STORE':'postgres','FOUNDRY_ACCESS_ENABLED':'true',
            'FOUNDRY_INSTANCE_DATABASE_URL':f'postgresql://foundry_instance_runtime:{secret}@postgres:5432/fork_connect',
            'FOUNDRY_ACCESS_ISSUER':activate.ISSUER,'FOUNDRY_ACCESS_AUDIENCE':secret,'FOUNDRY_PUBLIC_ORIGIN':activate.ORIGIN,
            **dict.fromkeys(activate.GATEWAY_FLAGS,'true'),'FOUNDRY_ARTIFACTS_ENABLED':'true',
            'FOUNDRY_AUTOMATION_ENABLED':'true',
            'FOUNDRY_AUTOMATION_DATABASE_URL':f'postgresql://foundry_automation_runtime:{secret}@postgres:5432/fork_automation',
            'FOUNDRY_AUTOMATION_TARGET':json.dumps({'deviceId':'a'*8+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*12,'environmentId':'b'*8+'-'+ 'b'*4+'-'+ 'b'*4+'-'+ 'b'*4+'-'+ 'b'*12,'allowedRunIds':[]}),
        }
        for change in [None, 'database', 'role', 'partial', 'artifact', 'old-runs', 'target-field']:
            with self.subTest(change=change):
                values = dict(base)
                if change == 'database': values['FOUNDRY_AUTOMATION_DATABASE_URL'] = values['FOUNDRY_INSTANCE_DATABASE_URL']
                if change == 'role': values['FOUNDRY_AUTOMATION_DATABASE_URL'] = values['FOUNDRY_AUTOMATION_DATABASE_URL'].replace('runtime','migrator')
                if change == 'partial': del values['FOUNDRY_AUTOMATION_TARGET']
                if change == 'artifact': del values['FOUNDRY_ARTIFACTS_ENABLED']
                if change in ['old-runs','target-field']:
                    target = json.loads(values['FOUNDRY_AUTOMATION_TARGET'])
                    if change == 'old-runs': target['allowedRunIds'] = ['legacy']
                    else: target['workerPool'] = '*'
                    values['FOUNDRY_AUTOMATION_TARGET'] = json.dumps(target)
                text = ''.join(f'{key}={value}\n' for key,value in values.items())
                if change is None: self.assertEqual(activate.parse_runtime(text),values)
                else:
                    with self.assertRaises(RuntimeError): activate.parse_runtime(text)

    def test_automation_grant_activation_and_recovery_use_the_service_at_current_generation(self):
        device_id = '22222222-2222-4222-8222-222222222222'
        environment_id = '33333333-3333-4333-8333-333333333333'
        instance_id = '11111111-1111-4111-8111-111111111111'
        for initial_enabled, failure in [(False,None),(True,None),(False,'grant-before'),(False,'grant-after'),(False,'verify'),(True,'verify'),(False,'recovery')]:
            with self.subTest(initial_enabled=initial_enabled,failure=failure), tempfile.TemporaryDirectory() as directory:
                config, state = Path(directory)/'config', Path(directory)/'state'
                config.mkdir(); state.mkdir()
                secret = 'a'*64
                values = {'FOUNDRY_INSTANCE_STORE':'postgres','FOUNDRY_ACCESS_ENABLED':'true',
                    'FOUNDRY_INSTANCE_DATABASE_URL':f'postgresql://foundry_instance_runtime:{secret}@postgres:5432/fork_connect',
                    'FOUNDRY_ACCESS_ISSUER':activate.ISSUER,'FOUNDRY_ACCESS_AUDIENCE':secret,'FOUNDRY_PUBLIC_ORIGIN':activate.ORIGIN,
                    **dict.fromkeys(activate.GATEWAY_FLAGS,'true'),'FOUNDRY_ARTIFACTS_ENABLED':'true'}
                original = ''.join(f'{key}={value}\n' for key,value in values.items())
                (config/'access-runtime.env').write_text(original)
                (config/'access-compose.json').write_text('{}')
                previous = {'automationEnabled':False,'artifactsEnabled':True,'image':activate.REGISTRY+'@'+DIGEST,'revision':REVISION,'instanceId':instance_id}
                grant = {'enabled':initial_enabled,'generation':7,'deviceGeneration':2,'instanceId':instance_id,
                    'operatorId':'44444444-4444-4444-8444-444444444444','environmentId':environment_id,'clientEnabled':True}
                before = dict(grant)
                calls = []
                running = True
                statuses = 0
                def status(expected_schema=None):
                    nonlocal statuses
                    statuses += 1
                    if statuses == 2 and failure in ['verify','recovery']: raise RuntimeError('verification failed')
                    return {**previous,'automationEnabled':'FOUNDRY_AUTOMATION_ENABLED=true' in (config/'access-runtime.env').read_text()}
                def sql(statement,database='fork_connect'):
                    self.assertNotIn('UPDATE foundry_instance.device_grants',statement)
                    if "'database', current_database()" in statement:
                        return json.dumps({'database':'fork_automation','owner':'foundry_automation_owner','objects':0,'schemas':0,'roles':0})
                    if "'enabled',g.enabled" in statement: return json.dumps(grant)
                    return ''
                def docker(*args,**kwargs):
                    nonlocal running
                    if args[0] == 'stop': running=False
                    return ''
                def start_main():
                    nonlocal running
                    running=True
                def cli(image,env_file,*args):
                    calls.append(args)
                    self.assertFalse(running)
                    if args[0] != 'automation-access': return
                    self.assertEqual(args[args.index('--device-id')+1],device_id)
                    self.assertEqual(args[args.index('--environment-id')+1],environment_id)
                    self.assertEqual(int(args[args.index('--generation')+1]),grant['generation'])
                    enabled = args[args.index('--enabled')+1] == 'true'
                    if enabled and failure == 'grant-before': raise RuntimeError('service rejected before commit')
                    if not enabled and failure == 'recovery': raise RuntimeError('recovery service unavailable')
                    grant['enabled']=enabled; grant['generation']+=1
                    if enabled and failure == 'grant-after': raise RuntimeError('service response lost after commit')
                with patch.object(activate,'CONFIG',config),patch.object(activate,'STATE',state), \
                     patch.object(activate,'active_status',status),patch.object(activate,'inspect',return_value={}), \
                     patch.object(activate,'check_postgres'),patch.object(activate,'sql',sql), \
                     patch.object(activate,'docker',docker),patch.object(activate,'start_main',start_main), \
                     patch.object(activate,'run_cli',cli),patch('sys.stdout',io.StringIO()),patch('sys.stderr',io.StringIO()):
                    if failure:
                        with self.assertRaises(RuntimeError): activate.enable_automation(device_id,environment_id)
                    else: activate.enable_automation(device_id,environment_id)
                backup=next(state.iterdir())
                self.assertEqual(json.loads((backup/'manifest.json').read_text())['previousAutomationGrant'],before)
                self.assertEqual((backup/'success').exists(),failure is None)
                self.assertFalse((backup/'migration.env').exists())
                if failure:
                    self.assertEqual((config/'access-runtime.env').read_text(),original)
                    self.assertEqual(grant['enabled'],True if failure == 'recovery' else initial_enabled)
                    self.assertEqual(running,failure != 'recovery')
                else:
                    self.assertTrue(grant['enabled']); self.assertTrue(running)
                access_calls=[call for call in calls if call[0]=='automation-access']
                if initial_enabled: self.assertEqual(access_calls,[])
                elif failure in ['grant-after','verify','recovery']: self.assertEqual(len(access_calls),2)
                else: self.assertEqual(len(access_calls),1)

    def test_automation_target_requires_verified_owner_instance_and_current_grant(self):
        device_id='22222222-2222-4222-8222-222222222222'
        environment_id='33333333-3333-4333-8333-333333333333'
        instance_id='11111111-1111-4111-8111-111111111111'
        grant={'enabled':False,'generation':1,'deviceGeneration':1,'instanceId':instance_id,
            'operatorId':'44444444-4444-4444-8444-444444444444','environmentId':environment_id,'clientEnabled':True}
        for value in ['',json.dumps({**grant,'instanceId':'foreign'}),json.dumps({**grant,'environmentId':'foreign'}),json.dumps({**grant,'generation':0})]:
            with self.subTest(value=value),patch.object(activate,'sql',return_value=value):
                with self.assertRaises(RuntimeError): activate.automation_grant(device_id,environment_id,instance_id)
        with patch.object(activate,'sql',return_value=json.dumps(grant)):
            self.assertEqual(activate.automation_grant(device_id,environment_id,instance_id),grant)

    def test_active_status_is_read_only_and_rejects_drift_without_disclosing_secrets(self):
        for drift in [None, 'environment', 'compose', 'schema', 'identity', 'migrator', 'permissions', 'gateway-on', 'gateway-v6', 'gateway-v7', 'gateway-capability', 'gateway-schema', 'artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-missing', 'artifacts-schema']:
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
                if drift in ['gateway-on', 'gateway-v6', 'gateway-v7', 'gateway-capability', 'gateway-schema', 'artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-missing', 'artifacts-schema']:
                    values.update(dict.fromkeys(activate.GATEWAY_FLAGS, 'true'))
                if drift in ['artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-missing', 'artifacts-schema']:
                    values['FOUNDRY_ARTIFACTS_ENABLED'] = 'true'
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
                    return json.dumps({'version': 8 if drift == 'schema' else 7 if drift in ['gateway-v7', 'artifacts-v7', 'archive-missing'] else 6 if drift in ['gateway-v6', 'gateway-v7', 'artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-missing'] else 5 if drift in ['gateway-on', 'gateway-capability', 'artifacts-schema'] else 2,
                        'instanceId': 'wrong' if drift == 'identity' else activate.INSTANCE,
                        'environmentId': activate.ENVIRONMENT, 'operatorBound': True,
                        'runtimeLogin': True, 'migratorLogin': drift == 'migrator'})

                def metadata(path):
                    return {'instanceId': activate.INSTANCE, 'mainEnvironmentId': activate.ENVIRONMENT,
                            'environmentId': activate.ENVIRONMENT, 'ready': True,
                            'capabilities': ['foundry.access-sessions'] + (sorted(activate.GATEWAY_CAPABILITIES) if drift in ['gateway-on', 'gateway-v6', 'gateway-v7', 'gateway-schema', 'artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-missing', 'artifacts-schema'] else []),
                            **({'threadArchive': {'protocolVersion': '1', 'pageSize': 50}} if drift == 'artifacts-v7' else {}),
                            **({'artifactTransfer': {'protocolVersion': '1', 'chunkBytes': 262144, 'maxBytes': 52428800}} if drift in ['artifacts-on', 'artifacts-v7', 'archive-missing', 'artifacts-schema'] else {})}

                lstat = Path.lstat

                def owned(path):
                    fields = list(lstat(path))
                    fields[4] = 0
                    return os.stat_result(fields)

                with patch.object(activate, 'CONFIG', config), patch.object(activate, 'docker', docker), \
                     patch.object(activate, 'sql', sql), patch.object(activate, 'metadata', metadata), \
                     patch.object(Path, 'lstat', owned):
                    if drift and drift not in ['gateway-on', 'gateway-v6', 'gateway-v7', 'artifacts-on', 'artifacts-v7']:
                        with self.assertRaises(RuntimeError) as error:
                            activate.active_status()
                        self.assertNotIn(secret, str(error.exception))
                    else:
                        report = activate.active_status()
                        self.assertEqual(report['revision'], REVISION)
                        self.assertFalse(report['upgradePerformed'])
                        self.assertEqual(report['gatewayEnabled'], drift in ['gateway-on', 'gateway-v6', 'gateway-v7', 'artifacts-on', 'artifacts-v7'])
                        self.assertEqual(report['artifactsEnabled'], drift in ['artifacts-on', 'artifacts-v7'])
                        self.assertNotIn(secret, json.dumps(report).replace(DIGEST, 'digest'))
                self.assertTrue(calls)

    def test_gateway_configuration_requires_the_complete_flag_set(self):
        base = {
            'FOUNDRY_INSTANCE_STORE': 'postgres', 'FOUNDRY_ACCESS_ENABLED': 'true',
            'FOUNDRY_INSTANCE_DATABASE_URL': 'postgresql://foundry_instance_runtime:' + 'a' * 64 + '@postgres:5432/fork_connect',
            'FOUNDRY_ACCESS_ISSUER': activate.ISSUER, 'FOUNDRY_ACCESS_AUDIENCE': 'b' * 64,
            'FOUNDRY_PUBLIC_ORIGIN': activate.ORIGIN,
        }
        render = lambda values: ''.join(f'{key}={value}\n' for key, value in values.items())
        self.assertEqual(activate.parse_runtime(render(base)), base)
        enabled = {**base, **dict.fromkeys(activate.GATEWAY_FLAGS, 'true')}
        self.assertEqual(activate.parse_runtime(render(enabled)), enabled)
        artifacts = {**enabled, 'FOUNDRY_ARTIFACTS_ENABLED': 'true'}
        self.assertEqual(activate.parse_runtime(render(artifacts)), artifacts)
        for invalid in [
            {**base, activate.GATEWAY_FLAGS[0]: 'true'},
            {**enabled, activate.GATEWAY_FLAGS[-1]: 'false'},
            {**enabled, 'FOUNDRY_UNKNOWN': 'true'},
            {**base, 'FOUNDRY_ARTIFACTS_ENABLED': 'true'},
            {**artifacts, 'FOUNDRY_ARTIFACTS_ENABLED': 'false'},
            {**base, 'FOUNDRY_ACCESS_ENABLED': 'false'},
        ]:
            with self.subTest(invalid=list(invalid)), self.assertRaises(RuntimeError):
                activate.parse_runtime(render(invalid))
        with self.assertRaises(RuntimeError):
            activate.parse_runtime(render(base) + 'FOUNDRY_ACCESS_ENABLED=true\n')

    def test_gateway_switch_is_config_only_idempotent_and_rolls_back_failure(self):
        for artifacts, schema, enabled, failure in [
            (artifacts, schema, enabled, failure)
            for artifacts, schema in [(False, 5), (False, 6), (True, 6)]
            for enabled, failure in [(True, None), (False, None), (True, 'start'), (True, 'verify'), (True, 'interrupt'), (True, 'rollback')]
        ]:
            with self.subTest(artifacts=artifacts, schema=schema, enabled=enabled, failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config, state = root / 'config', root / 'state'
                config.mkdir()
                state.mkdir()
                runtime = config / 'access-runtime.env'
                flags = (activate.ARTIFACT_FLAG,) if artifacts else activate.GATEWAY_FLAGS
                original = 'BASE=unchanged\n' + (''.join(f'{key}=true\n' for key in activate.GATEWAY_FLAGS) if artifacts else '')
                if not enabled:
                    original += ''.join(f'{key}=true\n' for key in flags)
                runtime.write_text(original)
                runtime.chmod(0o600)
                calls = []
                starts = 0
                statuses = 0

                def status(expected_schema=None):
                    nonlocal statuses
                    statuses += 1
                    self.assertIn(expected_schema, [None, schema])
                    if failure == 'verify' and statuses == 2:
                        raise RuntimeError('verification failed')
                    return {'gatewayEnabled': all(f'{key}=true\n' in runtime.read_text() for key in activate.GATEWAY_FLAGS),
                            'artifactsEnabled': f'{activate.ARTIFACT_FLAG}=true\n' in runtime.read_text(),
                            'schemaVersion': schema, 'image': activate.REGISTRY + '@' + DIGEST, 'revision': REVISION}

                def docker(*args, **kwargs):
                    nonlocal starts
                    calls.append(args)
                    self.assertIn(args[0], ['stop', 'compose'])
                    if args[0] == 'compose':
                        starts += 1
                        self.assertIn('--no-deps', args)
                        self.assertNotIn('--remove-orphans', args)
                        self.assertEqual(args[-1], 'main')
                        if failure == 'rollback' or (starts == 1 and failure in ['start', 'interrupt']):
                            raise KeyboardInterrupt() if failure == 'interrupt' else RuntimeError('start failed')
                    return ''

                with patch.object(activate, 'CONFIG', config), patch.object(activate, 'STATE', state), \
                     patch.object(activate, 'active_status', status), patch.object(activate, 'docker', docker), \
                     patch('sys.stdout', new=io.StringIO()), patch('sys.stderr', new=io.StringIO()):
                    if failure:
                        with self.assertRaises((RuntimeError, KeyboardInterrupt)):
                            activate.gateway(enabled, artifacts=artifacts)
                        self.assertEqual(runtime.read_text(), original)
                        self.assertEqual(starts, 2)
                        self.assertFalse(list(state.glob('*/success')))
                        if failure == 'rollback':
                            self.assertEqual(calls[-1], ('stop', '--time', '60', activate.MAIN))
                    else:
                        activate.gateway(enabled, artifacts=artifacts)
                        self.assertEqual('BASE=unchanged\n', ''.join(line + '\n' for line in runtime.read_text().splitlines() if not line.startswith('FOUNDRY_')))
                        self.assertEqual(status(expected_schema=schema)['artifactsEnabled' if artifacts else 'gatewayEnabled'], enabled)
                        self.assertEqual(runtime.stat().st_mode & 0o777, 0o600)
                        before = list(calls)
                        activate.gateway(enabled, artifacts=artifacts)
                        self.assertEqual(calls, before, 'same desired state must not restart Main')

        for current, artifacts, enabled in [
            ({'schemaVersion': 2, 'gatewayEnabled': False, 'artifactsEnabled': False}, False, True),
            ({'schemaVersion': 5, 'gatewayEnabled': True, 'artifactsEnabled': False}, True, True),
            ({'schemaVersion': 6, 'gatewayEnabled': False, 'artifactsEnabled': False}, True, True),
            ({'schemaVersion': 6, 'gatewayEnabled': True, 'artifactsEnabled': True}, False, False),
        ]:
            with self.subTest(current=current), patch.object(activate, 'active_status', return_value=current), \
                 patch.object(activate, 'docker', side_effect=AssertionError('No mutations before preconditions')), \
                 self.assertRaises(RuntimeError):
                activate.gateway(enabled, artifacts=artifacts)

    def test_upgrade_keeps_the_current_backup_and_disables_migration_login_on_failure(self):
        for same_schema, artifact_schema, archive_schema, current_schema, failure in (
            [(False, artifact, False, 5 if artifact else 2, f) for artifact in [False, True] for f in [None, 'source', 'backup', 'connections', 'migrate', 'disable', 'start', 'verify']]
            + [(True, False, False, schema, f) for schema in [5, 6, 7] for f in [None, 'source', 'backup', 'connections', 'start', 'verify']]
            + [(False, False, True, 6, f) for f in [None, 'source', 'backup', 'connections', 'migrate', 'disable', 'start', 'verify']]
        ):
            with self.subTest(same_schema=same_schema, artifact_schema=artifact_schema, failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target_schema = current_schema if same_schema else 7 if archive_schema else 6 if artifact_schema else 5
                config, state = root / 'config', root / 'state'
                config.mkdir()
                state.mkdir()
                for name in ['access-runtime.env', 'access-compose.json']:
                    (config / name).write_text('original-' + name)
                actions = []
                running = True

                def status(expected_schema=None):
                    actions.append(('status', expected_schema))
                    if len([a for a in actions if a[0] == 'status']) == 2 and failure == 'verify':
                        raise RuntimeError('verification failed')
                    candidate = len([a for a in actions if a[0] == 'status']) == 2
                    return {'schemaVersion': current_schema,
                            'image': activate.REGISTRY + '@' + (DIGEST if candidate else 'sha256:' + 'c' * 64),
                            'revision': REVISION if candidate else 'd' * 40}

                def docker(*args, data=None, output=None):
                    nonlocal running
                    actions.append(args)
                    if args[:2] == ('image', 'inspect'):
                        return json.dumps([{'Id': 'candidate', 'Os': 'linux', 'Architecture': 'amd64',
                            'Config': {'Labels': {'org.opencontainers.image.source':
                                'other' if failure == 'source' else activate.SOURCE,
                                'org.opencontainers.image.revision': REVISION}}}])
                    if args[0] == 'stop':
                        running = False
                    if args[0] == 'start':
                        running = True
                    if output is not None:
                        self.assertFalse(running)
                        if failure == 'backup':
                            raise RuntimeError('backup failed')
                        output.write(b'coordinated fixture')
                    if args[0] == 'run':
                        self.assertFalse(running)
                        recovery = next(state.iterdir())
                        self.assertTrue((recovery / 'backup-complete').is_file())
                        self.assertEqual((recovery / 'access-runtime.env').read_text(), 'original-access-runtime.env')
                        if failure == 'migrate':
                            raise RuntimeError('migration failed')
                    if args[0] == 'compose':
                        self.assertIn('--no-deps', args)
                        running = True
                        if failure == 'start':
                            raise RuntimeError('start failed')
                    return ''

                def sql(statement):
                    actions.append(('sql', statement))
                    if statement.startswith('SELECT count'):
                        return '1' if failure == 'connections' else '0'
                    if failure == 'disable' and 'NOLOGIN' in statement:
                        raise RuntimeError('disable failed')
                    return ''

                with patch.object(activate, 'CONFIG', config), patch.object(activate, 'STATE', state), \
                     patch.object(activate, 'active_status', status), patch.object(activate, 'docker', docker), \
                     patch.object(activate, 'sql', sql), patch('sys.stdout', new=io.StringIO()), \
                     patch('sys.stderr', new=io.StringIO()):
                    if failure:
                        with self.assertRaises(RuntimeError):
                            activate.upgrade(DIGEST, REVISION, same_schema=same_schema, artifact_schema=artifact_schema, archive_schema=archive_schema)
                    else:
                        activate.upgrade(DIGEST, REVISION, same_schema=same_schema, artifact_schema=artifact_schema, archive_schema=archive_schema)
                self.assertEqual(actions[0], ('status', None if same_schema else 6 if archive_schema else 5 if artifact_schema else 2))
                self.assertEqual(running, failure in [None, 'source', 'backup', 'connections'])
                altered = any(a[0] == 'sql' and 'LOGIN PASSWORD' in a[1] for a in actions)
                if failure in ['source', 'backup', 'connections']:
                    self.assertFalse(altered)
                    self.assertEqual((config / 'access-compose.json').read_text(), 'original-access-compose.json')
                else:
                    self.assertEqual(altered, not same_schema)
                    if same_schema:
                        self.assertFalse(any(a[0] == 'run' or (a[0] == 'sql' and 'ALTER ROLE' in a[1]) for a in actions))
                    else:
                        self.assertIn(('sql', 'ALTER ROLE foundry_instance_migrator NOLOGIN PASSWORD NULL;'), actions)
                    recovery = next(state.iterdir())
                    self.assertEqual(json.loads((recovery / 'manifest.json').read_text())['targetSchema'], target_schema)
                    self.assertEqual((recovery / 'access-compose.json').read_text(), 'original-access-compose.json')
                    self.assertEqual((recovery / 'success').exists(), failure is None)
                    self.assertEqual((config / 'access-runtime.env').read_text(), 'original-access-runtime.env')

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
