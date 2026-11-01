# Activate Access sessions on the existing Docker Main

This is the one-time transition from the restricted updater's file-store deployment
to P03 PostgreSQL sessions. It targets only `foundry-main-1`, `foundry-postgres-1`,
`fork_connect`, the existing Foundry volumes and `foundry_default` network. It does
not provision PostgreSQL, change Kubernetes or configure Cloudflare. Unexpected
containers, a nonempty database or existing instance login roles stop the operation.

The administrator runs this separately from the passwordless updater. Do not add
this program to sudoers or grant Docker access. Review and install the exact PR
revision first; the script is deliberately pinned to this deployment's IDs and origins.

## Before the maintenance window

### Inspect an already activated Main

After activation, neither the baseline updater nor `preflight` supports an upgrade.
From the reviewed checkout, an administrator can run the read-only inventory:

```sh
sudo /usr/bin/python3 -I deploy/fork/updater/activate-access.py status
```

This checks the actual image against the private Compose/runtime configuration,
the pinned identities, readiness, schema 2, operator binding and disabled migration
login. Its JSON contains no credentials or operator subject. It does not stop Main,
change the database or approve an upgrade. Configuration drift or a later schema
is rejected for explicit investigation. No installation or sudoers change is needed.

A later schema-5 upgrade needs a separate coordinated procedure: retain the old
image, stop Main, save state/workspaces and `fork_connect` together with the private
configuration, verify restoration in isolation, temporarily enable only the
migration login, migrate with the candidate image, disable that login again, then
start and verify the same IDs and intended capabilities. Recovery must restore the
matching database, volumes, configuration and old image; the activation-era empty
database backup is not a backup of the current Access sessions. Do not rerun
`activate` or follow an image-only deploy command from a build summary.

### First activation only

The remaining activation instructions apply only before PostgreSQL/Access has been
enabled. For an active instance, use the inventory above and prepare its upgrade
separately.

1. Verify the candidate Linux build succeeded, its source commit is the reviewed
   server revision, and its immutable GHCR digest is recorded. The activator checks
   image source/revision/platform labels; labels are not a substitute for build provenance.
2. Finish work in Docker Foundry. No other process may write its state, workspaces
   or `fork_connect` during the operation. The activation lock also excludes the
   existing restricted updater. Keep the previous image locally for recovery.
3. In trusted Cloudflare administration, verify the AUD **of this application** and
   the operator's Access JWT `sub` through its authenticated user/identity mapping.
   Confirm issuer `https://testenvnka.cloudflareaccess.com` and application origin
   `https://foundry.heavenforgeprod.com`. A Google subject, email, display name,
   decoded-but-unverified JWT or redirect query is not sufficient. If the mapping
   cannot be confirmed, stop; do not guess or bind the first visitor.
4. Ensure adequate disk space for state/workspace archives and a database dump.
   The stopped-state recovery bundle stays root-private under
   `/var/lib/foundry-deploy/access-*`. Copy it and the private configuration to the
   operator's existing protected backup destination before wider use. Local archives
   alone do not provide disaster recovery; this is not the P26 backup system.

From the reviewed checkout, the administrator installs **only this new executable**:

```sh
sudo install -o root -g root -m 755 deploy/fork/updater/activate-access.py /usr/local/sbin/foundry-activate-access
sudo /usr/local/sbin/foundry-activate-access preflight
```

`preflight` is read-only. It checks running Main, identities, readiness, private
PostgreSQL 17+, the NOLOGIN database owner, an empty `fork_connect`, absent instance
login roles and no other connections to that database. The agent's existing sudo
permission does not allow this new command. Do not reinstall the baseline updater
or run the original Compose file to activate sessions.

Create `/etc/foundry-deploy/access.json` using the administrator's private editor,
owned by root with mode `0600`, inside the existing root-only directory. Its complete
structure is:

```json
{
  "audience": "<confirmed 64-character lowercase application AUD>",
  "subject": "<confirmed Access operator subject>",
  "confirmation": "app-audience-and-operator-subject-verified"
}
```

The confirmation records the operator's verification; the script cannot establish
external account ownership itself. Do not put tokens, passwords or this private
file in chat, issues, shell history or the repository. No Cloudflare administrator
credential is needed by Main. Database passwords are generated locally during
activation and are never printed or passed as command-line arguments.

## Activate

The administrator substitutes the digest and source SHA from the successful build:

```sh
sudo /usr/local/sbin/foundry-activate-access activate sha256:<image-digest> <40-character-source-sha>
```

The operation pulls and checks the candidate before downtime. It stops Main, saves
`state.tar`, `workspaces.tar`, `fork_connect.dump`, `roles.sql`, the baseline Compose
file and a manifest with both images and identities. A backup failure restarts the
unchanged old container. It then:

- Creates separate `foundry_instance_migrator` and `foundry_instance_runtime` roles
  on the dedicated database; neither is administrator, database owner or a member
  of a privileged role. Runtime gets no CREATE/TEMP privilege.
- Writes runtime settings to root-only `/etc/foundry-deploy/access-runtime.env`;
  migration credentials exist only in the private recovery directory's `migration.env`.
  Docker receives each file separately. Main never receives migration/admin credentials.
- Runs the existing `foundry migrate` and `foundry bind-operator` CLI in the candidate
  image against the same `/var/lib/foundry` volume, as UID/GID 1000. No second Main
  server runs while these commands execute. Disables migrator login afterward.
- Starts only Main through `/etc/foundry-deploy/access-compose.json`, with the
  digest pinned, dropped capabilities and the existing loopback-only port.
  PostgreSQL and other services are not recreated.
- Requires readiness, the exact candidate image, both original identities and
  `foundry.access-sessions`. Any failure after backup leaves Main stopped for recovery.

The identities must remain:

```text
instanceId:      defd6cac-b437-407a-8a68-069161c9c1e4
mainEnvironmentId: 5aa1c74c-6ff2-4e24-b17f-d5c073c3c19f
```

Independent, nonsecret checks:

```sh
curl --fail http://127.0.0.1:3783/api/foundry/ready
curl --fail 'http://127.0.0.1:3783/.well-known/foundry?protocolVersion=1&requiredCapability=foundry.access-sessions'
```

Readiness and an advertised capability do not prove a real Access login. The baseline
`foundry-deploy status/deploy` intentionally refuses this customized deployment after
activation. Until a separately reviewed PostgreSQL update path exists, the
administrator owns updates via the new root-owned Compose file and coordinated
backups/migrations. Do not silently fall back to the old Compose configuration.

## Recovery before the first accepted Foundry session

An image downgrade is insufficient. The following is only for an aborted initial
activation, **before anyone has used the new sessions**. If activation has been used,
follow the next section. Keep the printed recovery directory and failed volumes;
never delete volumes or restore roles globally over a running PostgreSQL cluster.

As administrator, first stop only Main and disable any newly created login roles.
Use the fixed local Docker socket/config for all commands (the existing helper does
this automatically). Start a root shell without tracing and define:

```sh
unset DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE
export DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_CONFIG=/etc/foundry-deploy/docker
recovery=/var/lib/foundry-deploy/access-<exact-directory-from-activation>
docker stop --time 60 foundry-main-1
docker exec -i foundry-postgres-1 psql -X -v ON_ERROR_STOP=1 -U foundry_admin -d postgres <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='foundry_instance_runtime') THEN
    ALTER ROLE foundry_instance_runtime NOLOGIN;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='foundry_instance_migrator') THEN
    ALTER ROLE foundry_instance_migrator NOLOGIN;
  END IF;
END $$;
SQL
```

Read the root-private manifest. Use its `previousImage` for `previous_image` below;
check that this image is still present. Inspect both tar listings and the dump listing
before restoration. Restore state/workspaces into **new, empty** recovery volumes,
leaving the failed volumes intact:

```sh
previous_image=sha256:<previousImage-from-manifest>
docker image inspect "$previous_image" --format '{{.Id}}'
tar -tf "$recovery/state.tar" >/dev/null
tar -tf "$recovery/workspaces.tar" >/dev/null
docker exec -i foundry-postgres-1 pg_restore --list < "$recovery/fork_connect.dump" >/dev/null
# Choose fresh names; refuse to reuse volumes or containers from an earlier restore.
if docker volume inspect foundry_access_restore_state >/dev/null 2>&1 ||
   docker volume inspect foundry_access_restore_workspaces >/dev/null 2>&1; then
  echo 'Recovery volume already exists; stop and choose new names.' >&2
  exit 1
fi
docker volume create foundry_access_restore_state
docker volume create foundry_access_restore_workspaces
docker create --name foundry-access-restore --network none --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount type=volume,src=foundry_access_restore_state,dst=/var/lib/foundry \
  --mount type=volume,src=foundry_access_restore_workspaces,dst=/workspaces \
  "$previous_image"
docker cp -a - foundry-access-restore:/var/lib/foundry < "$recovery/state.tar"
docker cp -a - foundry-access-restore:/workspaces < "$recovery/workspaces.tar"
docker rm foundry-access-restore
```

The restore container is never started. Review a private copy of
`baseline-compose.yml`: replace only the two external volume names with these new
recovery volumes, and pin `image` to `previousImage`. Keep the port, network, UID and
security settings. This avoids overwriting failed Main-state evidence.

Restore **only** `fork_connect` from the coordinated pre-activation dump. This drops
the failed activation's database contents, so confirm that this was the unused initial
activation and no new sessions/work were accepted. Do not restore `roles.sql` globally;
retain it as recovery evidence. PostgreSQL, `fork_automation` and their existing roles
remain in place:

```sh
docker exec -i foundry-postgres-1 pg_restore -U foundry_admin --exit-on-error \
  --clean --if-exists --create -d postgres < "$recovery/fork_connect.dump"
```

The restored database's owner/ACLs come from the dump. Newly created instance roles
remain NOLOGIN. Start only Main using the reviewed recovery Compose file:

```sh
docker compose --project-name foundry --env-file /dev/null \
  --file "$recovery/recovery-compose.yml" up --detach --no-deps --no-build \
  --pull never --wait main
```

Verify the original IDs and readiness again. Retain the activation files and failed
volumes for diagnosis; do not rerun activation blindly. The one-time script intentionally
rejects this recovery layout, existing files and roles until an administrator has
reconciled them.

## Recovery after sessions have been used

PostgreSQL is now authoritative. Never switch to file storage or restore the
pre-activation database to recover an established instance. Stop Main and take a new
coordinated state/workspace/database backup. Restore a compatible schema-2 backup
and matching Main state into separate storage, retain the operator binding, and
invalidate restored sessions before reopening access:

```sql
BEGIN;
UPDATE foundry_instance.instance SET access_generation = access_generation + 1;
DELETE FROM foundry_instance.sessions;
COMMIT;
```

Run this locally against the restored `fork_connect` only, with Main stopped; retain
both IDs. Use the P03-capable image associated with that backup. Existing T3 sessions
and external Cloudflare grants have their own recovery/revocation paths. If no valid
post-activation backup exists, keep Main stopped and repair forward from the preserved
database instead of downgrading its authentication state.

## Continue Windows P04 acceptance

Use the already isolated Foundry installer; never an old `Programs\t3code` uninstaller.
Record client SHA/installer hash and server SHA/image digest for each observation.
Start with:

```powershell
& "$env:LOCALAPPDATA\Programs\foundry\Foundry.exe" -- --foundry-access-probe 'https://foundry.heavenforgeprod.com' 'https://testenvnka.cloudflareaccess.com' 'defd6cac-b437-407a-8a68-069161c9c1e4'
```

Perform these checks with the maintainer after the capability check succeeds:

1. Sign in through the system browser. Require successful Foundry authentication,
   then **Check session**. This proves the Foundry auth API, not arbitrary T3 API access.
2. **Open instance** and use the existing T3 pairing path in this isolated partition.
   Verify an actual WebSocket-backed UI operation and reconnect. Foundry sessions
   currently authorize the Foundry auth endpoints; they do not replace T3 pairing
   or implement the future gateway's WebSocket authorization.
3. Explicitly refresh, inspect the session again and reopen the instance. Also let a
   Foundry session expire without refresh (at most 15 minutes, possibly earlier):
   **Check session** must fail. Check Access grant expiry separately; do not alter
   production policies just to accelerate the test.
4. Close/relaunch the probe while the session is still valid, then **Check session**.
   Coordinate a separate Main restart with the administrator and repeat. Never
   confuse a fresh login with persistence of the previous session.
5. Log out, restart the probe and verify that no prior Foundry session resumes.
   Record remote revocation failures as failures even if local storage was cleared.
   A still-valid Cloudflare browser SSO can permit a _new_ login.
6. Verify isolation against a separately authorized second instance, plus identity/
   issuer mismatch rejection. A mistyped UUID alone is not a two-instance isolation
   proof. No second instance is provisioned by this runbook.

Do not export cookies, CSRF values, tokens or the probe profile as evidence. Record
only action, HTTP/result category, pinned IDs, tested builds and whether the observation
was automated or made by the maintainer. Missing Windows, WebSocket, expiry/restart,
revocation or second-instance evidence leaves the respective P04 gate open.

## Isolated verification of this operation

```sh
python3 -m unittest discover -s deploy/fork/updater -p 'test_*.py'
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin python3 deploy/fork/updater/verify-access-postgres.py
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin vp run --filter t3 test:foundry-postgres
```

The first command checks the Docker command boundary and failure ordering with
fixtures. The second starts a temporary local PostgreSQL cluster and exercises role
provisioning, runtime denial and pre-activation dump restoration. The third checks the
real application migration/session services on another temporary cluster. These do
not establish that the live Docker activation, full Docker-volume restore or real
Windows acceptance has succeeded.
