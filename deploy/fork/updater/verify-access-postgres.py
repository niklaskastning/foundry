#!/usr/bin/env python3
"""Explicit isolated check: FOUNDRY_TEST_PG_BIN=/path/to/bin python3 this-file."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('activation', Path(__file__).with_name('activate-access.py'))
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


def verify():
    binary = Path(os.environ['FOUNDRY_TEST_PG_BIN'])
    with tempfile.TemporaryDirectory(prefix='foundry-activation-pg-') as directory:
        root = Path(directory)
        data = root / 'data'

        def pg(name, *args, input=None):
            return subprocess.run([str(binary / name), *args], input=input, capture_output=True,
                                  env={**os.environ, 'LC_ALL': 'C', 'PGHOST': str(root), 'PGPORT': '5432'},
                                  check=True).stdout

        pg('initdb', '-D', str(data), '-U', 'foundry_admin', '--auth=trust', '--no-locale')
        pg('pg_ctl', '-D', str(data), '-l', str(root / 'server.log'), '-o',
           f'-k {root} -c listen_addresses=', '-w', 'start')
        try:
            def query(statement, database='fork_connect', user='foundry_admin'):
                return pg('psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database,
                          input=statement.encode()).decode().strip()

            query('CREATE ROLE foundry_connect_owner NOLOGIN;', 'postgres')
            query('CREATE DATABASE fork_connect OWNER foundry_connect_owner;', 'postgres')
            activation.sql = query
            activation.check_empty_database()
            backup = pg('pg_dump', '-U', 'foundry_admin', '-Fc', 'fork_connect')
            pg('pg_restore', '--list', input=backup)
            activation.provision_roles('a' * 64, 'b' * 64)
            assert query("SELECT has_database_privilege(current_user,current_database(),'CREATE') OR has_database_privilege(current_user,current_database(),'TEMP');", user='foundry_instance_runtime') == 'f'
            assert query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname='foundry_instance_runtime';") == 't'
            query('CREATE SCHEMA foundry_instance; CREATE TABLE foundry_instance.fixture(value text);', user='foundry_instance_migrator')
            try:
                query('CREATE TABLE public.denied(value text);', user='foundry_instance_runtime')
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError('Runtime DDL unexpectedly succeeded')
            query('ALTER ROLE foundry_instance_migrator NOLOGIN;')
            assert query("SELECT rolcanlogin FROM pg_roles WHERE rolname='foundry_instance_migrator';") == 'f'
            pg('pg_restore', '-U', 'foundry_admin', '--exit-on-error', '--clean', '--if-exists', '--create', '-d', 'postgres', input=backup)
            query('DROP ROLE foundry_instance_runtime; DROP ROLE foundry_instance_migrator;')
            activation.check_empty_database()
            print('PASS isolated PostgreSQL: empty-database guards, separate roles, SCRAM credentials, denied runtime DDL, migrator disable, pre-activation dump restore.')
        finally:
            pg('pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop')


if __name__ == '__main__':
    verify()
