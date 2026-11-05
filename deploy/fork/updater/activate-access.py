#!/usr/bin/python3 -I
"""Operator-run activation, inventory, updates and gateway toggle of Docker Foundry."""

import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.request

CONFIG = Path('/etc/foundry-deploy')
STATE = Path('/var/lib/foundry-deploy')
MAIN = 'foundry-main-1'
POSTGRES = 'foundry-postgres-1'
REGISTRY = 'ghcr.io/niklaskastning/foundry'
SOURCE = 'https://github.com/niklaskastning/foundry'
INSTANCE = 'defd6cac-b437-407a-8a68-069161c9c1e4'
ENVIRONMENT = '5aa1c74c-6ff2-4e24-b17f-d5c073c3c19f'
ISSUER = 'https://testenvnka.cloudflareaccess.com'
ORIGIN = 'https://foundry.heavenforgeprod.com'
GATEWAY_FLAGS = (
    'FOUNDRY_DEVICE_ENROLLMENT_ENABLED', 'FOUNDRY_DEVICE_CHANNEL_ENABLED',
    'FOUNDRY_GATEWAY_GRANTS_ENABLED', 'FOUNDRY_HTTP_GATEWAY_ENABLED',
    'FOUNDRY_STREAM_GATEWAY_ENABLED',
)
GATEWAY_CAPABILITIES = {
    'foundry.device-enrollment', 'foundry.device-channel', 'foundry.http-gateway',
    'foundry.rpc-streams', 'foundry.device-catalog',
}
ARTIFACT_FLAG = 'FOUNDRY_ARTIFACTS_ENABLED'
ARTIFACT_TRANSFER = {'protocolVersion': '1', 'chunkBytes': 262144, 'maxBytes': 52428800}
AUTOMATION_KEYS = {'FOUNDRY_AUTOMATION_ENABLED', 'FOUNDRY_AUTOMATION_DATABASE_URL', 'FOUNDRY_AUTOMATION_TARGET'}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'}


def docker(*args, data=None, output=None):
    result = subprocess.run(
        ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', '--config',
         str(CONFIG / 'docker'), *args], cwd='/', env=ENV,
        input=data, stdin=subprocess.DEVNULL if data is None else None,
        stdout=output if output is not None else subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=1800, check=False,
    )
    if result.returncode:
        # CLI/SQL errors can contain credentials; never echo command arguments or stderr.
        raise RuntimeError('Docker operation failed; Main may remain stopped. See the recovery runbook.')
    return result.stdout.decode().strip() if output is None else ''


def inspect(name):
    return json.loads(docker('container', 'inspect', name))[0]


def metadata(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:3783' + path, timeout=10) as response:
        return json.load(response)


def check_identity(descriptor, environment):
    if (descriptor.get('instanceId') != INSTANCE
            or descriptor.get('mainEnvironmentId') != ENVIRONMENT
            or environment.get('environmentId') != ENVIRONMENT):
        raise RuntimeError('The pinned instance/environment identity differs.')


def check_main(current, baseline=True):
    labels = current['Config'].get('Labels') or {}
    mounts = {m['Destination']: (m['Type'], m.get('Name')) for m in current['Mounts']}
    if (labels.get('com.docker.compose.project') != 'foundry'
            or labels.get('com.docker.compose.service') != 'main'
            or mounts != {'/var/lib/foundry': ('volume', 'foundry_foundry-state'),
                          '/workspaces': ('volume', 'foundry_foundry-workspaces')}
            or current['HostConfig']['PortBindings'] != {
                '3773/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3783'}]}
            or set(current['NetworkSettings']['Networks']) != {'foundry_default'}
            or not current['State']['Running']):
        raise RuntimeError('Main is not the expected running Foundry deployment.')
    original = json.loads(docker('image', 'inspect', current['Image']))[0]
    if baseline and (any(value.startswith('FOUNDRY_') for value in current['Config'].get('Env') or [])
            or set(current['Config'].get('Env') or []) != set(original['Config'].get('Env') or [])):
        raise RuntimeError('Only the baseline file-store deployment can be activated once.')


def parse_runtime(text):
    runtime = text.splitlines()
    entries = [line.split('=', 1) for line in runtime if line]
    expected = {'FOUNDRY_INSTANCE_STORE', 'FOUNDRY_ACCESS_ENABLED', 'FOUNDRY_INSTANCE_DATABASE_URL',
                'FOUNDRY_ACCESS_ISSUER', 'FOUNDRY_ACCESS_AUDIENCE', 'FOUNDRY_PUBLIC_ORIGIN'}
    if any(len(entry) != 2 for entry in entries) or len(dict(entries)) != len(entries):
        raise RuntimeError('Unexpected active runtime configuration.')
    values = dict(entries)
    extra = set(values) - expected - {ARTIFACT_FLAG} - AUTOMATION_KEYS
    automation = AUTOMATION_KEYS.intersection(values)
    if automation:
        if (automation != AUTOMATION_KEYS or values['FOUNDRY_AUTOMATION_ENABLED'] != 'true'
                or values.get(ARTIFACT_FLAG) != 'true'
                or not re.fullmatch(r'postgresql://foundry_automation_runtime:[a-f0-9]{64}@postgres:5432/fork_automation', values['FOUNDRY_AUTOMATION_DATABASE_URL'])):
            raise RuntimeError('Automation requires its complete separate database profile.')
        target = json.loads(values['FOUNDRY_AUTOMATION_TARGET'])
        if (set(target) != {'deviceId', 'environmentId', 'allowedRunIds'}
                or any(not isinstance(target[key], str) or not re.fullmatch(r'[a-f0-9-]{36}', target[key]) for key in ['deviceId', 'environmentId'])
                or target['allowedRunIds'] != []):
            raise RuntimeError('Product automation requires one explicit worker and no legacy fixture allowlist.')
    if extra and (extra != set(GATEWAY_FLAGS) or any(values[key] != 'true' for key in GATEWAY_FLAGS)):
        raise RuntimeError('Supply either no gateway flags or the complete enabled gateway profile.')
    if ARTIFACT_FLAG in values and (values[ARTIFACT_FLAG] != 'true' or extra != set(GATEWAY_FLAGS)):
        raise RuntimeError('Artifact transfers require the complete gateway profile and an explicit true flag.')
    if (not expected.issubset(values) or values['FOUNDRY_INSTANCE_STORE'] != 'postgres'
            or values['FOUNDRY_ACCESS_ENABLED'] != 'true' or values['FOUNDRY_ACCESS_ISSUER'] != ISSUER
            or values['FOUNDRY_PUBLIC_ORIGIN'] != ORIGIN
            or not re.fullmatch(r'[a-f0-9]{64}', values['FOUNDRY_ACCESS_AUDIENCE'])
            or not re.fullmatch(r'postgresql://foundry_instance_runtime:[a-f0-9]{64}@postgres:5432/fork_connect',
                                values['FOUNDRY_INSTANCE_DATABASE_URL'])):
        raise RuntimeError('Active runtime configuration differs from the one-time activation format.')
    return values


def active_status(expected_schema=None, expected_automation_schema=None):
    current = inspect(MAIN)
    check_main(current, baseline=False)
    check_postgres(inspect(POSTGRES))
    image = json.loads(docker('image', 'inspect', current['Image']))[0]
    labels = image['Config'].get('Labels') or {}
    revision = labels.get('org.opencontainers.image.revision', '')
    if labels.get('org.opencontainers.image.source') != SOURCE or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise RuntimeError('Running image has no confirmed Foundry source revision.')
    runtime_file = CONFIG / 'access-runtime.env'
    for path in [runtime_file, CONFIG / 'access-compose.json']:
        stat = path.lstat()
        if path.is_symlink() or not path.is_file() or stat.st_uid != 0 or stat.st_mode & 0o077:
            raise RuntimeError('Active configuration must be root-owned and private.')
    values = parse_runtime(runtime_file.read_text())
    configured = json.loads((CONFIG / 'access-compose.json').read_text())
    configured_image = configured.get('services', {}).get('main', {}).get('image', '')
    if (not re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', configured_image)
            or configured != composition(configured_image, runtime_file)
            or json.loads(docker('image', 'inspect', configured_image))[0]['Id'] != current['Image']):
        raise RuntimeError('Active Compose configuration differs from the running image or expected layout.')
    actual = dict(value.split('=', 1) for value in current['Config'].get('Env') or [])
    base = dict(value.split('=', 1) for value in image['Config'].get('Env') or [])
    if actual != {**base, **values}:
        raise RuntimeError('Running environment differs from the private configuration.')
    descriptor = metadata('/.well-known/foundry?protocolVersion=1')
    check_identity(descriptor, metadata('/.well-known/t3/environment'))
    if (metadata('/api/foundry/ready').get('ready') is not True
            or 'foundry.access-sessions' not in descriptor.get('capabilities', [])):
        raise RuntimeError('Main is not ready with Access sessions enabled.')
    database = json.loads(sql("""BEGIN READ ONLY;
      SELECT json_build_object(
        'version', (SELECT version FROM foundry_instance.schema_version),
        'instanceId', (SELECT instance_id FROM foundry_instance.instance),
        'environmentId', (SELECT main_environment_id FROM foundry_instance.instance),
        'operatorBound', (SELECT count(*)=1 FROM foundry_instance.operator_binding),
        'runtimeLogin', (SELECT rolcanlogin FROM pg_roles WHERE rolname='foundry_instance_runtime'),
        'migratorLogin', (SELECT rolcanlogin FROM pg_roles WHERE rolname='foundry_instance_migrator'));
      COMMIT;"""))
    if (database['version'] not in ([expected_schema] if expected_schema else [2, 5, 6, 7]) or database['instanceId'] != INSTANCE
            or database['environmentId'] != ENVIRONMENT or database['operatorBound'] is not True
            or database['runtimeLogin'] is not True or database['migratorLogin'] is not False):
        raise RuntimeError('Unexpected instance schema, identity, operator binding or login state.')
    gateway_enabled = all(values.get(key) == 'true' for key in GATEWAY_FLAGS)
    advertised = GATEWAY_CAPABILITIES.intersection(descriptor.get('capabilities', []))
    if (advertised != (GATEWAY_CAPABILITIES if gateway_enabled else set())
            or (gateway_enabled and database['version'] not in [5, 6, 7])):
        raise RuntimeError('Gateway capabilities or schema differ from the configured profile.')
    artifacts_enabled = values.get(ARTIFACT_FLAG) == 'true'
    if (descriptor.get('artifactTransfer') != (ARTIFACT_TRANSFER if artifacts_enabled else None)
            or (artifacts_enabled and (database['version'] not in [6, 7] or not gateway_enabled))):
        raise RuntimeError('Artifact transfer metadata or schema differs from the configured profile.')
    if descriptor.get('threadArchive') != ({'protocolVersion': '1', 'pageSize': 50}
            if artifacts_enabled and database['version'] == 7 else None):
        raise RuntimeError('Thread archive metadata differs from the configured profile or schema.')
    automation_enabled = values.get('FOUNDRY_AUTOMATION_ENABLED') == 'true'
    if descriptor.get('automation') != ({'protocolVersion': '1'} if automation_enabled else None):
        raise RuntimeError('Automation capability differs from configured profile.')
    automation_schema = None
    if automation_enabled:
        automation_schema = int(sql("BEGIN READ ONLY; SELECT version FROM foundry_automation.schema_version; COMMIT;", database='fork_automation'))
        if automation_schema not in ([expected_automation_schema] if expected_automation_schema else [5, 6, 7]):
            raise RuntimeError('Automation schema is incompatible.')
    return {'automationSchemaVersion': automation_schema, 'automationEnabled': automation_enabled, 'gatewayEnabled': gateway_enabled, 'artifactsEnabled': artifacts_enabled, 'revision': revision, 'image': configured_image, 'schemaVersion': database['version'],
            'instanceId': INSTANCE, 'environmentId': ENVIRONMENT, 'ready': True,
            'operatorBound': True, 'migratorLogin': False, 'configurationMatches': True,
            'upgradePerformed': False}


def start_main():
    docker('compose', '--project-name', 'foundry', '--env-file', '/dev/null',
           '--file', str(CONFIG / 'access-compose.json'), 'up', '--detach', '--no-deps',
           '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'main')


def gateway(enabled, *, artifacts=False):
    previous = active_status()
    schema = previous['schemaVersion']
    if schema not in [5, 6, 7] or (artifacts and (schema not in [6, 7] or not previous['gatewayEnabled'])):
        raise RuntimeError('This profile requires the migrated gateway; artifacts require schema 6 or 7.')
    if not artifacts and not enabled and previous['artifactsEnabled']:
        raise RuntimeError('Disable artifact publication on workers and Main before disabling the gateway.')
    field = 'artifactsEnabled' if artifacts else 'gatewayEnabled'
    flags = (ARTIFACT_FLAG,) if artifacts else GATEWAY_FLAGS
    if previous[field] == enabled:
        print(json.dumps({**previous, 'configurationChanged': False}, indent=2))
        return
    runtime = CONFIG / 'access-runtime.env'
    original = runtime.read_text()
    lines = [line for line in original.splitlines() if line.split('=', 1)[0] not in flags]
    if enabled:
        lines.extend(f'{key}=true' for key in flags)
    recovery = Path(tempfile.mkdtemp(prefix='artifacts-' if artifacts else 'gateway-', dir=STATE))
    write_private(recovery / 'access-runtime.env', original)
    write_private(recovery / 'manifest.json', json.dumps(previous, indent=2) + '\n')
    replacement = recovery / 'candidate-runtime.env'
    write_private(replacement, '\n'.join(lines) + '\n')
    print(f'Configuration recovery directory: {recovery}', flush=True)
    try:
        docker('stop', '--time', '60', MAIN)
        os.replace(replacement, runtime)
        start_main()
        result = active_status(expected_schema=schema)
        if (result[field] != enabled or result['image'] != previous['image']
                or result['revision'] != previous['revision']):
            raise RuntimeError('Profile configuration verification failed.')
    except BaseException:
        try:
            docker('stop', '--time', '60', MAIN)
            rollback = recovery / 'rollback-runtime.env'
            write_private(rollback, original)
            os.replace(rollback, runtime)
            start_main()
            restored = active_status(expected_schema=schema)
            if any(restored[key] != previous[key] for key in ['gatewayEnabled', 'artifactsEnabled', 'schemaVersion', 'image', 'revision']):
                raise RuntimeError('Previous configuration could not be verified.')
        except BaseException:
            docker('stop', '--time', '60', MAIN)
            raise RuntimeError(f'Main stays stopped. Restore the runtime configuration from {recovery}.') from None
        print('Previous Main configuration restored; profile change failed.', file=sys.stderr)
        raise
    write_private(recovery / 'success', 'enabled\n' if enabled else 'disabled\n')
    print(json.dumps({**result, 'configurationChanged': True, 'configurationRecovery': str(recovery)}, indent=2))


def upgrade(digest, revision, *, same_schema=False, artifact_schema=False, archive_schema=False, automation_schema=False):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Use an immutable image digest and its exact reviewed source SHA.')
    if sum([same_schema, artifact_schema, archive_schema, automation_schema]) > 1:
        raise ValueError('A schema upgrade cannot be a same-schema update.')
    previous = active_status(expected_schema=7, expected_automation_schema=6) if automation_schema else active_status(expected_schema=None if same_schema else 6 if archive_schema else 5 if artifact_schema else 2)
    if automation_schema and not previous.get('automationEnabled'):
        raise RuntimeError('Automation schema upgrade requires the active schema-6 profile.')
    if same_schema and previous['schemaVersion'] not in [5, 6, 7]:
        raise RuntimeError('Same-schema updates require gateway schema 5, 6 or 7.')
    target_schema = previous['schemaVersion'] if same_schema or automation_schema else 7 if archive_schema else 6 if artifact_schema else 5
    image = REGISTRY + '@' + digest
    docker('pull', image)
    candidate = json.loads(docker('image', 'inspect', image))[0]
    labels = candidate['Config'].get('Labels') or {}
    if (labels.get('org.opencontainers.image.source') != SOURCE
            or labels.get('org.opencontainers.image.revision') != revision
            or candidate.get('Os') != 'linux' or candidate.get('Architecture') != 'amd64'):
        raise RuntimeError('Candidate source, revision or platform differs.')
    backup = Path(tempfile.mkdtemp(prefix='upgrade-', dir=STATE))
    write_private(backup / 'manifest.json', json.dumps({
        'previous': previous, 'candidateImage': image, 'revision': revision,
        'targetSchema': target_schema, 'targetAutomationSchema': 7 if automation_schema else previous.get('automationSchemaVersion'), 'instanceId': INSTANCE, 'environmentId': ENVIRONMENT,
    }, indent=2) + '\n')
    for name in ['access-runtime.env', 'access-compose.json']:
        write_private(backup / name, (CONFIG / name).read_text())
    print(f'Recovery directory: {backup}', flush=True)
    docker('stop', '--time', '60', MAIN)
    try:
        save(backup / 'state.tar', 'cp', f'{MAIN}:/var/lib/foundry/.', '-')
        save(backup / 'workspaces.tar', 'cp', f'{MAIN}:/workspaces/.', '-')
        save(backup / 'fork_connect.dump', 'exec', POSTGRES, 'pg_dump', '-U', 'foundry_admin', '-Fc', 'fork_connect')
        if previous.get('automationEnabled'):
            save(backup / 'fork_automation.dump', 'exec', POSTGRES, 'pg_dump', '-U', 'foundry_admin', '-Fc', 'fork_automation')
            docker('exec', '-i', POSTGRES, 'pg_restore', '--list', data=(backup / 'fork_automation.dump').read_bytes())
            if sql("SELECT count(*) FROM pg_stat_activity WHERE datname='fork_automation' AND pid<>pg_backend_pid();", database='fork_automation') != '0':
                raise RuntimeError('Another connection is using fork_automation; no migration performed.')
        save(backup / 'roles.sql', 'exec', POSTGRES, 'pg_dumpall', '-U', 'foundry_admin', '--roles-only')
        docker('exec', '-i', POSTGRES, 'pg_restore', '--list', data=(backup / 'fork_connect.dump').read_bytes())
        if sql("SELECT count(*) FROM pg_stat_activity WHERE datname='fork_connect' AND pid<>pg_backend_pid();") != '0':
            raise RuntimeError('Another connection is using fork_connect; no migration performed.')
        write_private(backup / 'backup-complete', 'Coordinated pre-upgrade backup completed.\n')
    except BaseException:
        docker('start', MAIN)
        raise
    migration_file = backup / 'migration.env'
    try:
        if not same_schema and not automation_schema:
            password = secrets.token_hex(32)
            write_private(migration_file,
                          f'FOUNDRY_INSTANCE_MIGRATION_URL=postgresql://foundry_instance_migrator:{password}@postgres:5432/fork_connect\n')
            try:
                sql(f"ALTER ROLE foundry_instance_migrator LOGIN PASSWORD '{password}';")
                print(f"Migrating schema {previous['schemaVersion']} to {target_schema} with Main stopped; operator and identities are preserved.", flush=True)
                run_cli(image, migration_file, 'migrate', '--base-dir', '/var/lib/foundry',
                        '--runtime-role', 'foundry_instance_runtime')
            finally:
                sql('ALTER ROLE foundry_instance_migrator NOLOGIN PASSWORD NULL;')
            migration_file.unlink()
        if automation_schema:
            password = secrets.token_hex(32)
            write_private(migration_file,
                          f'FOUNDRY_AUTOMATION_MIGRATION_URL=postgresql://foundry_automation_migrator:{password}@postgres:5432/fork_automation\n')
            try:
                sql(f"ALTER ROLE foundry_automation_migrator LOGIN PASSWORD '{password}';")
                run_cli(image, migration_file, 'automation-migrate', '--database', 'fork_automation',
                        '--runtime-role', 'foundry_automation_runtime')
                if sql("SELECT version FROM foundry_automation.schema_version;", database='fork_automation') != '7':
                    raise RuntimeError('Automation migration did not confirm schema 7.')
            finally:
                try:
                    sql('ALTER ROLE foundry_automation_migrator NOLOGIN PASSWORD NULL;')
                finally:
                    migration_file.unlink(missing_ok=True)
        replacement = backup / 'candidate-compose.json'
        write_private(replacement, json.dumps(composition(image, CONFIG / 'access-runtime.env'), indent=2) + '\n')
        os.replace(replacement, CONFIG / 'access-compose.json')
        docker('compose', '--project-name', 'foundry', '--env-file', '/dev/null',
               '--file', str(CONFIG / 'access-compose.json'), 'up', '--detach', '--no-deps',
               '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'main')
        result = active_status(expected_schema=target_schema, expected_automation_schema=7) if automation_schema else active_status(expected_schema=target_schema)
        if result['image'] != image or result['revision'] != revision:
            raise RuntimeError('Candidate image verification failed.')
        write_private(backup / 'success', revision + '\n')
        print(json.dumps({**result, 'upgradePerformed': True, 'backup': str(backup)}, indent=2))
    except BaseException:
        docker('stop', '--time', '60', MAIN)
        print(f'Main stays stopped. Restore the coordinated backup {backup}; never downgrade only the image.', file=sys.stderr)
        raise


def check_postgres(current):
    labels = current['Config'].get('Labels') or {}
    data = [m for m in current['Mounts'] if m['Destination'] == '/var/lib/postgresql/data']
    if (labels.get('com.docker.compose.project') != 'foundry'
            or labels.get('com.docker.compose.service') != 'postgres'
            or len(data) != 1 or data[0].get('Name') != 'foundry_foundry-postgres'
            or data[0]['Type'] != 'volume'
            or current['HostConfig'].get('PortBindings')
            or set(current['NetworkSettings']['Networks']) != {'foundry_default'}
            or not current['State']['Running']):
        raise RuntimeError('PostgreSQL is not the expected private Foundry deployment.')


def sql(statement, database='fork_connect'):
    return docker('exec', '-i', POSTGRES, 'psql', '-X', '-qAt', '--set', 'ON_ERROR_STOP=1',
                  '-U', 'foundry_admin', '-d', database, data=statement.encode())


def check_empty_database():
    result = sql("""SELECT json_build_object(
      'owner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
      'ownerLogin', (SELECT rolcanlogin FROM pg_roles WHERE rolname='foundry_connect_owner'),
      'version', current_setting('server_version_num')::integer,
      'schemas', (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')),
      'objects', (SELECT count(*) FROM (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
        UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') objects),
      'roles', (SELECT count(*) FROM pg_roles WHERE rolname IN ('foundry_instance_migrator','foundry_instance_runtime')),
      'connections', (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));""")
    state = json.loads(result)
    if (state['owner'] != 'foundry_connect_owner' or state['ownerLogin'] is not False
            or state['version'] < 170000 or any(state[k] != 0 for k in ['schemas', 'objects', 'roles', 'connections'])):
        raise RuntimeError('Expected an unused empty fork_connect database and absent instance login roles.')
    return state


def preflight():
    current = inspect(MAIN)
    check_main(current)
    check_postgres(inspect(POSTGRES))
    check_identity(metadata('/.well-known/foundry?protocolVersion=1'),
                   metadata('/.well-known/t3/environment'))
    if metadata('/api/foundry/ready').get('ready') is not True:
        raise RuntimeError('Baseline Main is not ready.')
    check_empty_database()
    return current


def private_json(path):
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_uid != 0 or stat.st_mode & 0o077:
        raise RuntimeError('Access configuration must be a root-owned regular file, mode 0600.')
    value = json.loads(path.read_text())
    if (set(value) != {'audience', 'subject', 'confirmation'}
            or not re.fullmatch(r'[a-f0-9]{64}', value['audience'])
            or not isinstance(value['subject'], str) or not value['subject'].strip()
            or len(value['subject']) > 512 or any(ord(c) < 32 for c in value['subject'])
            or value['confirmation'] != 'app-audience-and-operator-subject-verified'):
        raise RuntimeError('Confirm the application AUD and operator Subject through trusted Access administration first.')
    return value


def write_private(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())


def save(path, *args):
    with path.open('xb') as output:
        docker(*args, output=output)
        output.flush()
        os.fsync(output.fileno())
    if path.stat().st_size == 0:
        raise RuntimeError('Empty backup; refusing activation.')


def composition(image, runtime_file):
    return {'name': 'foundry', 'services': {'main': {
        'image': image, 'user': '1000:1000', 'cap_drop': ['ALL'],
        'security_opt': ['no-new-privileges:true'], 'restart': 'unless-stopped',
        'ports': ['127.0.0.1:3783:3773'], 'env_file': [str(runtime_file)],
        'volumes': ['foundry-state:/var/lib/foundry', 'foundry-workspaces:/workspaces'],
        'networks': ['foundry'],
        'healthcheck': {'test': ['CMD', 'node', '-e',
            "fetch('http://127.0.0.1:3773/api/foundry/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
            'interval': '5s', 'timeout': '5s', 'start_period': '60s', 'retries': 12},
        'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}},
    }}, 'volumes': {
        'foundry-state': {'external': True, 'name': 'foundry_foundry-state'},
        'foundry-workspaces': {'external': True, 'name': 'foundry_foundry-workspaces'},
    }, 'networks': {'foundry': {'external': True, 'name': 'foundry_default'}}}


def run_cli(image, env_file, *args):
    docker('run', '--rm', '--user', '1000:1000', '--cap-drop', 'ALL',
           '--security-opt', 'no-new-privileges:true', '--network', 'foundry_default',
           '--mount', 'type=volume,src=foundry_foundry-state,dst=/var/lib/foundry',
           '--env-file', str(env_file), image, 'node', 'dist/bin.mjs', 'foundry', *args)


def provision_roles(runtime_password, migration_password):
    sql(f"""BEGIN;
          CREATE ROLE foundry_instance_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{migration_password}';
          CREATE ROLE foundry_instance_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{runtime_password}';
          REVOKE ALL ON DATABASE fork_connect FROM PUBLIC;
          REVOKE ALL ON SCHEMA public FROM PUBLIC;
          GRANT CONNECT, CREATE ON DATABASE fork_connect TO foundry_instance_migrator;
          GRANT CONNECT ON DATABASE fork_connect TO foundry_instance_runtime;
          COMMIT;""")


def activate(digest, revision):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Use an immutable image digest and its exact reviewed source SHA.')
    access = private_json(CONFIG / 'access.json')
    if (CONFIG / 'access-compose.json').exists() or (CONFIG / 'access-runtime.env').exists():
        raise RuntimeError('Activation files already exist. Inspect the previous attempt; do not overwrite it.')
    previous = preflight()
    image = REGISTRY + '@' + digest
    docker('pull', image)
    candidate = json.loads(docker('image', 'inspect', image))[0]
    labels = candidate['Config'].get('Labels') or {}
    if (labels.get('org.opencontainers.image.source') != SOURCE
            or labels.get('org.opencontainers.image.revision') != revision
            or candidate.get('Os') != 'linux' or candidate.get('Architecture') != 'amd64'):
        raise RuntimeError('Candidate source, revision or platform differs.')
    backup = Path(tempfile.mkdtemp(prefix='access-', dir=STATE))
    manifest = {'previousImage': previous['Image'], 'candidateImage': image, 'revision': revision,
                'instanceId': INSTANCE, 'environmentId': ENVIRONMENT}
    write_private(backup / 'manifest.json', json.dumps(manifest, indent=2) + '\n')
    write_private(backup / 'baseline-compose.yml', (CONFIG / 'compose.yml').read_text())
    print(f'Recovery directory: {backup}', flush=True)
    print('Stopping Main and saving the coordinated recovery bundle.', flush=True)
    docker('stop', '--time', '60', MAIN)
    try:
        save(backup / 'state.tar', 'cp', f'{MAIN}:/var/lib/foundry/.', '-')
        save(backup / 'workspaces.tar', 'cp', f'{MAIN}:/workspaces/.', '-')
        save(backup / 'fork_connect.dump', 'exec', POSTGRES, 'pg_dump', '-U', 'foundry_admin', '-Fc', 'fork_connect')
        save(backup / 'roles.sql', 'exec', POSTGRES, 'pg_dumpall', '-U', 'foundry_admin', '--roles-only')
        docker('exec', '-i', POSTGRES, 'pg_restore', '--list', data=(backup / 'fork_connect.dump').read_bytes())
        check_empty_database()
    except BaseException:
        docker('start', MAIN)
        raise
    try:
        runtime_password, migration_password = secrets.token_hex(32), secrets.token_hex(32)
        runtime_url = f'postgresql://foundry_instance_runtime:{runtime_password}@postgres:5432/fork_connect'
        migration_url = f'postgresql://foundry_instance_migrator:{migration_password}@postgres:5432/fork_connect'
        runtime_file = CONFIG / 'access-runtime.env'
        migration_file = backup / 'migration.env'
        write_private(runtime_file, '\n'.join([
            'FOUNDRY_INSTANCE_STORE=postgres', 'FOUNDRY_ACCESS_ENABLED=true',
            f'FOUNDRY_INSTANCE_DATABASE_URL={runtime_url}', f'FOUNDRY_ACCESS_ISSUER={ISSUER}',
            f'FOUNDRY_ACCESS_AUDIENCE={access["audience"]}', f'FOUNDRY_PUBLIC_ORIGIN={ORIGIN}', '',
        ]))
        write_private(migration_file, f'FOUNDRY_INSTANCE_MIGRATION_URL={migration_url}\n')
        print('Provisioning separate roles and migrating the preserved Main identity.', flush=True)
        provision_roles(runtime_password, migration_password)
        run_cli(image, migration_file, 'migrate', '--base-dir', '/var/lib/foundry',
                '--runtime-role', 'foundry_instance_runtime')
        print('Binding the operator confirmed in the private configuration.', flush=True)
        run_cli(image, runtime_file, 'bind-operator', '--base-dir', '/var/lib/foundry',
                '--issuer', ISSUER, '--subject', access['subject'])
        sql('ALTER ROLE foundry_instance_migrator NOLOGIN;')
        compose = CONFIG / 'access-compose.json'
        write_private(compose, json.dumps(composition(image, runtime_file), indent=2) + '\n')
        print('Starting Main and verifying image, readiness, identities and capability.', flush=True)
        docker('compose', '--project-name', 'foundry', '--env-file', '/dev/null', '--file', str(compose),
               'up', '--detach', '--no-deps', '--no-build', '--pull', 'never', '--wait',
               '--wait-timeout', '180', 'main')
        descriptor = metadata('/.well-known/foundry?protocolVersion=1')
        check_identity(descriptor, metadata('/.well-known/t3/environment'))
        if (inspect(MAIN)['Image'] != candidate['Id']
                or metadata('/api/foundry/ready').get('ready') is not True
                or 'foundry.access-sessions' not in descriptor.get('capabilities', [])):
            raise RuntimeError('Candidate image, readiness or Access capability verification failed.')
        write_private(backup / 'success', revision + '\n')
        print(f'Activated {revision}; pinned IDs unchanged; foundry.access-sessions advertised. Backup: {backup}')
    except BaseException:
        docker('stop', '--time', '60', MAIN)
        print(f'Main stays stopped. Recover using {backup}; never downgrade only the image.', file=sys.stderr)
        raise



def automation_grant(device_id, environment_id, instance_id):
    row = sql(f"""BEGIN READ ONLY; SELECT json_build_object(
      'enabled',g.enabled,'generation',g.generation,'deviceGeneration',d.generation,
      'instanceId',d.instance_id,'operatorId',d.operator_id,'environmentId',d.environment_id,
      'clientEnabled',c.enabled)
      FROM foundry_instance.devices d
      JOIN foundry_instance.instance i ON i.instance_id=d.instance_id
      JOIN foundry_instance.operator_binding b ON b.singleton=i.singleton AND b.operator_id=d.operator_id
      JOIN foundry_instance.device_grants g ON g.device_id=d.device_id AND g.kind='automationExecution'
      JOIN foundry_instance.device_grants c ON c.device_id=d.device_id AND c.kind='clientAccess'
      WHERE d.device_id='{device_id}' AND d.environment_id='{environment_id}' AND NOT d.revoked; COMMIT;""")
    if not row:
        raise RuntimeError('The selected worker is not owned by the verified instance operator.')
    grant = json.loads(row)
    if (grant.get('instanceId') != instance_id or grant.get('environmentId') != environment_id
            or type(grant.get('enabled')) is not bool or type(grant.get('clientEnabled')) is not bool or type(grant.get('generation')) is not int
            or grant['generation'] < 1 or type(grant.get('deviceGeneration')) is not int
            or grant['deviceGeneration'] < 1 or not re.fullmatch(r'[a-f0-9-]{36}',grant.get('operatorId',''))):
        raise RuntimeError('The selected worker grant does not match the verified instance binding.')
    return grant


def change_automation_grant(image, device_id, environment_id, expected, enabled):
    run_cli(image, CONFIG / 'access-runtime.env', 'automation-access', '--base-dir', '/var/lib/foundry',
            '--device-id', device_id, '--environment-id', environment_id,
            '--generation', str(expected['generation']), '--enabled', str(enabled).lower())
    current = automation_grant(device_id, environment_id, expected['instanceId'])
    if (current != {**expected,'enabled':enabled,'generation':expected['generation']+1}):
        raise RuntimeError('Automation grant service did not confirm the expected generation.')
    return current


def enable_automation(device_id, environment_id):
    if any(not re.fullmatch(r'[a-f0-9-]{36}', value) for value in [device_id, environment_id]):
        raise ValueError('Supply explicit device and environment UUIDs.')
    previous = active_status(expected_schema=7)
    if previous.get('automationEnabled') or not previous['artifactsEnabled']:
        raise RuntimeError('Automation must be inactive and archive transfers enabled.')
    check_postgres(inspect(POSTGRES))
    state = json.loads(sql("""BEGIN READ ONLY; SELECT json_build_object(
      'database', current_database(),
      'owner', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
      'objects', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'),
      'schemas', (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')),
      'roles', (SELECT count(*) FROM pg_roles WHERE rolname IN ('foundry_automation_runtime','foundry_automation_migrator'))); COMMIT;""", database='fork_automation'))
    if state != {'database':'fork_automation','owner':'foundry_automation_owner','objects':0,'schemas':0,'roles':0}:
        raise RuntimeError('Expected the verified empty Automation database and absent runtime roles.')
    previous_grant = automation_grant(device_id, environment_id, previous['instanceId'])
    if not previous_grant['clientEnabled']:
        raise RuntimeError('The selected worker requires its independent client access grant.')
    backup = Path(tempfile.mkdtemp(prefix='automation-', dir=STATE))
    write_private(backup / 'manifest.json', json.dumps({'previous':previous,'targetRevision':previous['revision'],'automationSchema':5,'previousAutomationGrant':previous_grant,'recovery':'Restore previous runtime profile and selected worker grant through automation-access at its current generation; keep separate Automation database inactive. No image downgrade.'},indent=2)+'\n')
    for name in ['access-runtime.env','access-compose.json']:
        write_private(backup / name, (CONFIG / name).read_text())
    runtime_password, migration_password = secrets.token_hex(32), secrets.token_hex(32)
    migration_file = backup / 'migration.env'
    docker('stop','--time','60',MAIN)
    grant_change_attempted = False
    expected_grant = previous_grant
    try:
        sql(f"""BEGIN;
          CREATE ROLE foundry_automation_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{migration_password}';
          CREATE ROLE foundry_automation_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{runtime_password}';
          REVOKE ALL ON DATABASE fork_automation FROM PUBLIC;
          REVOKE ALL ON SCHEMA public FROM PUBLIC;
          GRANT CONNECT,CREATE ON DATABASE fork_automation TO foundry_automation_migrator;
          GRANT CONNECT ON DATABASE fork_automation TO foundry_automation_runtime; COMMIT;""", database='fork_automation')
        write_private(migration_file, f'FOUNDRY_AUTOMATION_MIGRATION_URL=postgresql://foundry_automation_migrator:{migration_password}@postgres:5432/fork_automation\n')
        try:
            run_cli(previous['image'],migration_file,'automation-migrate','--database','fork_automation','--runtime-role','foundry_automation_runtime')
        finally:
            sql('ALTER ROLE foundry_automation_migrator NOLOGIN PASSWORD NULL;')
            migration_file.unlink(missing_ok=True)
        if not previous_grant['enabled']:
            grant_change_attempted = True
            expected_grant = change_automation_grant(previous['image'],device_id,environment_id,previous_grant,True)
        target = json.dumps({'deviceId':device_id,'environmentId':environment_id,'allowedRunIds':[]},separators=(',',':'))
        text = (backup / 'access-runtime.env').read_text() + f'FOUNDRY_AUTOMATION_ENABLED=true\nFOUNDRY_AUTOMATION_DATABASE_URL=postgresql://foundry_automation_runtime:{runtime_password}@postgres:5432/fork_automation\nFOUNDRY_AUTOMATION_TARGET={target}\n'
        parse_runtime(text)
        candidate = backup / 'candidate-runtime.env'
        write_private(candidate,text)
        os.replace(candidate,CONFIG / 'access-runtime.env')
        start_main()
        result = active_status(expected_schema=7)
        current_grant = automation_grant(device_id,environment_id,previous['instanceId'])
        if current_grant != expected_grant:
            raise RuntimeError('The configured automation worker grant is not enabled.')
        write_private(backup / 'success',previous['revision']+'\n')
        print(json.dumps({**result,'recovery':str(backup),'existingRunsActivated':False,'automationGrantGeneration':current_grant['generation']},indent=2))
    except BaseException:
        docker('stop','--time','60',MAIN)
        rollback = backup / 'rollback-runtime.env'
        write_private(rollback,(backup / 'access-runtime.env').read_text())
        os.replace(rollback,CONFIG / 'access-runtime.env')
        try:
            if grant_change_attempted:
                current_grant = automation_grant(device_id,environment_id,previous['instanceId'])
                if current_grant != previous_grant:
                    if current_grant != {**previous_grant,'enabled':True,'generation':previous_grant['generation']+1}:
                        raise RuntimeError('Worker grant changed independently; automatic recovery will not overwrite it.')
                    change_automation_grant(previous['image'],device_id,environment_id,current_grant,previous_grant['enabled'])
            start_main()
            restored = active_status(expected_schema=7)
            if any(restored[key] != previous[key] for key in ['automationEnabled','image','revision','instanceId']):
                raise RuntimeError('The inactive runtime profile could not be verified after recovery.')
        except BaseException:
            docker('stop','--time','60',MAIN)
            print(f'Main stays stopped; restore the recorded worker grant and inactive runtime profile using {backup}.',file=sys.stderr)
            raise
        print(f'Automation remains inactive and the prior worker grant state is restored. Recovery: {backup}',file=sys.stderr)
        raise

def main(args):
    if not (len(args) == 4 and args[:2] == ['automation', 'enable']) and args not in [['preflight'], ['status'], ['gateway', 'enable'], ['gateway', 'disable'], ['artifacts', 'enable'], ['artifacts', 'disable']] and not (len(args) == 3 and args[0] in ['activate', 'upgrade', 'upgrade-artifacts', 'upgrade-archive', 'upgrade-automation', 'update']):
        raise ValueError('Usage: foundry-activate-access status | preflight | gateway|artifacts enable|disable | activate|upgrade|upgrade-artifacts|upgrade-archive|upgrade-automation|update sha256:<digest> <source-sha>')
    if os.geteuid() != 0:
        raise RuntimeError('This operation requires the administrator; no sudo grant is installed.')
    os.umask(0o077)
    with (STATE / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args[:2] == ['automation','enable']:
            enable_automation(*args[2:])
        elif args == ['status']:
            print(json.dumps(active_status(), indent=2))
        elif args[0] in ['gateway', 'artifacts']:
            gateway(args[1] == 'enable', artifacts=args[0] == 'artifacts')
        elif args == ['preflight']:
            preflight()
            print('PASS pinned Docker Main, private PostgreSQL, empty fork_connect, absent login roles, stable IDs.')
        elif args[0] in ['upgrade', 'upgrade-artifacts', 'upgrade-archive', 'upgrade-automation', 'update']:
            upgrade(*args[1:], same_schema=args[0] == 'update', artifact_schema=args[0] == 'upgrade-artifacts', archive_schema=args[0] == 'upgrade-archive', automation_schema=args[0] == 'upgrade-automation')
        else:
            activate(*args[1:])


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (Exception, KeyboardInterrupt) as error:
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        print('Foundry operation stopped. Check the preconditions and recovery runbook; no secret diagnostics are printed.', file=sys.stderr)
        sys.exit(1)
