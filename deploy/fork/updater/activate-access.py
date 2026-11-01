#!/usr/bin/python3 -I
"""One-time operator-run activation of the existing Docker Foundry instance."""

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


def active_status():
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
    runtime = runtime_file.read_text().splitlines()
    entries = [line.split('=', 1) for line in runtime if line]
    expected = {'FOUNDRY_INSTANCE_STORE', 'FOUNDRY_ACCESS_ENABLED', 'FOUNDRY_INSTANCE_DATABASE_URL',
                'FOUNDRY_ACCESS_ISSUER', 'FOUNDRY_ACCESS_AUDIENCE', 'FOUNDRY_PUBLIC_ORIGIN'}
    if any(len(entry) != 2 for entry in entries) or len(entries) != len(expected):
        raise RuntimeError('Unexpected active runtime configuration.')
    values = dict(entries)
    if (set(values) != expected or values['FOUNDRY_INSTANCE_STORE'] != 'postgres'
            or values['FOUNDRY_ACCESS_ENABLED'] != 'true' or values['FOUNDRY_ACCESS_ISSUER'] != ISSUER
            or values['FOUNDRY_PUBLIC_ORIGIN'] != ORIGIN
            or not re.fullmatch(r'[a-f0-9]{64}', values['FOUNDRY_ACCESS_AUDIENCE'])
            or not re.fullmatch(r'postgresql://foundry_instance_runtime:[a-f0-9]{64}@postgres:5432/fork_connect',
                                values['FOUNDRY_INSTANCE_DATABASE_URL'])):
        raise RuntimeError('Active runtime configuration differs from the one-time activation format.')
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
    if (database['version'] != 2 or database['instanceId'] != INSTANCE
            or database['environmentId'] != ENVIRONMENT or database['operatorBound'] is not True
            or database['runtimeLogin'] is not True or database['migratorLogin'] is not False):
        raise RuntimeError('Expected the activated schema-2 instance with a disabled migration login.')
    return {'revision': revision, 'image': configured_image, 'schemaVersion': database['version'],
            'instanceId': INSTANCE, 'environmentId': ENVIRONMENT, 'ready': True,
            'operatorBound': True, 'migratorLogin': False, 'configurationMatches': True,
            'upgradePerformed': False}


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


def sql(statement):
    return docker('exec', '-i', POSTGRES, 'psql', '-X', '-qAt', '--set', 'ON_ERROR_STOP=1',
                  '-U', 'foundry_admin', '-d', 'fork_connect', data=statement.encode())


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
    with path.open('x', encoding='utf-8') as output:
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


def main(args):
    if args not in [['preflight'], ['status']] and not (len(args) == 3 and args[0] == 'activate'):
        raise ValueError('Usage: foundry-activate-access status | preflight | activate sha256:<digest> <source-sha>')
    if os.geteuid() != 0:
        raise RuntimeError('This one-time operation requires the administrator; no sudo grant is installed.')
    os.umask(0o077)
    with (STATE / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args == ['status']:
            print(json.dumps(active_status(), indent=2))
        elif args == ['preflight']:
            preflight()
            print('PASS pinned Docker Main, private PostgreSQL, empty fork_connect, absent login roles, stable IDs.')
        else:
            activate(*args[1:])


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (Exception, KeyboardInterrupt) as error:
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        print('Activation stopped. Check the preconditions and recovery runbook; no secret diagnostics are printed.', file=sys.stderr)
        sys.exit(1)
