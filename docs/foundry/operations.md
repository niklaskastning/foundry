# Foundry on the Linux VPS

Foundry serves the shared Web client and T3 backend at `http://127.0.0.1:3783`. The existing host `cloudflared` service should route `foundry.heavenforgeprod.com` to that origin. Keep Cloudflare Access enabled for this hostname, including HTTP and WebSocket paths. Do not expose port 3783 or PostgreSQL publicly.

This is the isolated base deployment, not the planned instance gateway, Automation engine, or host worker. The backend still uses its own local SQLite state. PostgreSQL has empty `fork_automation` and `fork_connect` databases reserved for their separate future migrations. No application receives the database administrator credential. Owner roles cannot log in; runtime and migration logins are provisioned with the services that need them.

## Experimental device enrollment (P06)

Der separate Linux-Host-Dienst hat einen [eigenen Installer und Betriebsweg](../../deploy/fork/worker/README.md). Er wird nicht durch Main-Deployment oder Device-Enrollment installiert; seine reale Dienstkonto-/G2-Abnahme bleibt offen.

This opt-in backend registers a device key and its first local environment. It does
not connect that environment, provide gateway access or install an agent. The
outstanding release gates and follow-up work are tracked in
[issue #13](https://github.com/niklaskastning/foundry/issues/13). Do not activate it
on the existing production deployment as part of development testing.

Use an isolated Main with PostgreSQL instance schema **5**, the existing operator
binding, and the configured `FOUNDRY_PUBLIC_ORIGIN`. Run the existing
`foundry migrate` command with the migration role before starting this source
version; it upgrades schemas 1/2/3/4 while preserving instance identity, operator and
sessions. Older binaries reject schema 5: an image-only downgrade is not
a recovery procedure. The runtime role cannot change device keys or enrollment
expiry. Set `FOUNDRY_DEVICE_ENROLLMENT_ENABLED=true` explicitly alongside
`FOUNDRY_ACCESS_ENABLED=true` to expose `/api/foundry/devices/enroll` and advertise
`foundry.device-enrollment`; the route and capability are absent by default.
This mode does not implement native authentication.

From the source checkout, create a private key file on the execution machine:

```sh
umask 077
node apps/server/src/bin.ts foundry device-keygen --output /private/device-key.json
```

Keep that file on the device. Send only its `publicKey` field and the confirmed
local T3 environment ID to the operator through a trusted channel. On Main, using
its explicit isolated home and runtime database configuration:

```sh
node apps/server/src/bin.ts foundry approve-device --base-dir /isolated/main \
  --public-key <confirmed-public-key> --environment-id <device-environment-id> \
  --output /private/invitation.json
```

The confidential invitation expires after ten minutes. Confirm its instance ID,
origin and environment with the operator, transfer it to that device, then sign it:

```sh
node apps/server/src/bin.ts foundry sign-enrollment \
  --invitation /private/invitation.json --key-file /private/device-key.json \
  --output /private/enrollment-request.json
```

POST that JSON file to the invitation's exact HTTPS origin at
`/api/foundry/devices/enroll`, using the separately provisioned Access machine
credential if Access protects the route. Do not put credentials in command-line
arguments or follow redirects. No Cloudflare policy or service token is created
by these commands. The response contains the public registration, device ID and
generation; it is not a bearer credential. A lost response can be retried with the
same signed request within its expiry and returns the same registration. Another
key/environment or a second registration for that key/environment is rejected.
Delete the invitation/request after success; retain the device's private key and
public registration securely. Output files are created exclusively with mode 0600
and existing files are never overwritten.

Revoke locally on Main with its explicit home and runtime database configuration:

```sh
node apps/server/src/bin.ts foundry revoke-device --base-dir /isolated/main \
  --device-id <registered-device-id>
```

Revocation is durable and idempotent. Replaying the original enrollment cannot
reactivate the device. Replacing a revoked key/environment is not supported yet;
there is no implicit reset or deletion command. Main's own environment cannot be
registered as an execution device.

## Experimental outgoing device channel (P07)

On an isolated schema-5 Main, explicitly enable
`FOUNDRY_DEVICE_CHANNEL_ENABLED=true` alongside the Access and enrollment flags.
This exposes the authenticated WebSocket at `/api/foundry/devices/channel` and
advertises `foundry.device-channel`. The default remains disabled. No client
gateway, project API, filesystem or provider access is exposed by this flag alone.

On the execution machine, use the P06 key and registration response, the confirmed
Main HTTPS origin, and the explicit home of the existing local T3 environment:

```sh
node apps/server/src/bin.ts foundry connect-device \
  --base-dir /isolated/worker --origin https://main.example.com \
  --registration /private/registration.json --key-file /private/device-key.json \
  --access-file /private/access-machine.json
```

The optional Access file contains `origin`, `clientId` and `clientSecret`; keep it
owner-readable and never put it in the repository. Its origin must exactly match
the chosen Main before any credential is sent. Provision the machine credential
separately for the intended Access path. The connector does not create tokens or
change Cloudflare policy. Omit this file only when that endpoint needs no outer
Access machine credential. Redirects and invalid TLS certificates are rejected.

The connector reads `userdata/environment-id` from the specified home and checks
it against the registration before connecting and on each heartbeat. It creates
no local identity, backend or provider process. Stop it with Ctrl+C. Lost channels
redial with a fresh signed challenge and bounded backoff (1–30 seconds); a wrong
identity/key, revoked registration or superseded channel stops the connector.
An initial connection log means the device channel is authenticated, not that a
T3 client can access it through Main.

Authentication has a ten-second deadline. Heartbeats run every ten seconds with
acknowledgement; Main closes a channel without activity for thirty seconds.
Each heartbeat rechecks PostgreSQL registration/generation; DB failure closes the
channel rather than keeping an unverified grant alive. Every successful handshake
advances a durable channel generation, fencing previous channels, including those
from another Main process. This is a single-Main design, not an HA routing system.
Control frames are limited to 4 KiB and outgoing socket buffering is bounded.
There is no command replay. HTTP project reads require the separate P08 opt-ins below. Real machine/Access and
Windows integration remain tracked separately in issue #13.

## Experimental gateway project reads (P08)

This exposes only typed project-list reads, not a general T3 connection, device
catalog, mutation, file API or stream. Real machine/Access/Windows integration
and the remaining G2 packages are tracked in
[issue #13](https://github.com/niklaskastning/foundry/issues/13).
Do not enable it on the production deployment for testing.

On an isolated Main with P03 and P06/P07 enabled,
`FOUNDRY_GATEWAY_GRANTS_ENABLED=true` enables POST endpoints under
`/api/foundry/gateway/grants/`: `create`, `inspect`, and `remove`.
Each request needs the valid Foundry cookie, `x-foundry-csrf`, exact public
`Origin`, JSON content type, and a separately authenticated T3 session.
DPoP-bound T3 credentials require a fresh proof for the actual public request
URL and method; a Foundry session alone grants no device access.

`create` accepts `{deviceId, environmentId, scopes: ["orchestration:read"]}`.
Only explicitly held read permission can be delegated, and the registered device
must have a current authenticated P07 connection. `inspect` and `remove` accept
`{grantId, deviceId, environmentId}`. Handles are bound to the exact Foundry and
T3 sessions, actor, device identity and channel generation; they are not bearer
credentials. Every inspection reauthenticates and checks the current device
lease. Reconnect invalidates old handles. Removal affects only the specified
grant, including when its device is offline.

Grants expire within 60 seconds (earlier when either parent session expires),
are limited to 128 in-memory entries per Main, and disappear on Main restart.
Logout or session renewal requires a new grant; read-only grants cannot request
mutation scopes. Grants alone do not enable forwarding.

For the read path, additionally set `FOUNDRY_HTTP_GATEWAY_ENABLED=true` on the
isolated Main. It advertises `foundry.http-gateway` and enables
`POST /api/foundry/gateway/projects`, accepting `{grantId, deviceId, environmentId}`
with the same authenticated headers. The result is the existing typed T3
`ProjectSnapshot`; there is no caller-selected path, method, header or destination.
This flag requires the grant flag. Defaults remain disabled.

On the execution machine, add `--gateway-origin http://127.0.0.1:3773` to
`connect-device`, using the actual port of its already-running isolated T3
backend. The origin must be exactly an IPv4 loopback HTTP origin, without path,
query or credentials. Its descriptor must match the registered environment.
The explicit home must belong to that environment; this opt-in uses its existing
T3 session store. It does not start a backend or touch other T3 profiles.

The connector signs its project-read opt-in into the handshake. The adapter
creates a fresh `orchestration:read` T3 session per request, bound to its local
DPoP key and valid for at most five seconds. The versioned session subject records
the Foundry actor, origin, grant and device/channel binding. A fresh proof binds
`GET /api/projects` on the actual local URL. No Main cookie, bearer token or
client DPoP proof is forwarded. The local session is revoked when the request
finishes, fails or is cancelled; a crash leaves only its short expiry.

One request may be in flight per device. Requests and heartbeats share the
existing socket reader; HTTP data is not retried after reconnect. Local JSON
responses are limited to 64 KiB, channel frames to 128 KiB (control frames 4 KiB),
and socket output buffering is bounded. The local operation has a five-second
deadline and Main waits at most ten seconds for its response. Cancellation or a
missing response closes that channel; reconnect requires a new grant. Main
rechecks session/grant authority before dispatch and before returning data,
and checks the registry generation on dispatch and response. Redirects,
non-JSON bodies, oversized responses and mismatched identities fail; device
cookies and response headers are never forwarded.

These isolated paths do not constitute Windows, P08/G1/G2 or production
acceptance. No persistent Foundry migration is added by this HTTP adapter.

## Build and start

From the repository root, install Vite+ and run `vp i`. `vp run foundry:build server` creates the server and Web bundle locally. The container builds these itself and ships only the server package and production dependencies; it runs as the unprivileged `node` user.

Create a private PostgreSQL password file outside the repository. Set its absolute path in the gitignored `deploy/fork/.env`, using `.env.example` as the template. Keep that file and the password owner-readable only. Do not change the password file on an initialized database expecting it to rotate the database password: initialization only happens on a new volume.

```sh
docker compose --env-file deploy/fork/.env -f deploy/fork/compose.yml build
docker compose --env-file deploy/fork/.env -f deploy/fork/compose.yml up -d --wait
docker compose --env-file deploy/fork/.env -f deploy/fork/compose.yml ps
curl --fail http://127.0.0.1:3783/.well-known/t3/environment
```

Use `sudo` if required by the host's Docker policy. The Compose project is named `foundry`; its volumes keep T3 state, workspaces, and PostgreSQL data separate from other installations. Never mount a personal `~/.t3` into it. `restart: unless-stopped` starts the services again after the Docker daemon restarts. The healthchecks cover each component; the backend does not yet consume PostgreSQL, so its HTTP health does not claim Automation readiness.

Set `FOUNDRY_REVISION` to the source commit and use an immutable `FOUNDRY_IMAGE` tag for releases. Pin the PostgreSQL image digest before a production rollout. Update the container through Compose, not `t3 update`; Foundry rejects the inherited self-update and remote-update paths and does not query official npm releases.

## Manual Actions build and restricted VPS update

For the existing Docker development instance, select **Foundry build (manual)** in
Actions, choose a reviewed branch and `linux`, and enable `publish_linux`. The run
publishes `ghcr.io/niklaskastning/foundry:<commit>` and reports its immutable digest
and deploy command in the job summary. No push or PR automatically deploys anything.
Unmerged branches are supported for deliberate development testing; selecting a
branch does not merge its PR. Review the exact build commit before deployment.

After the first publication, the repository owner must make the **foundry** container
package public in its GitHub package settings. Packages start private even for public
repositories. The VPS then pulls anonymously; no GitHub, SSH or Cloudflare credential
is installed on it for this update path. See [GitHub's container registry guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The owner installs the reviewed helper once from the checkout:

```sh
sudo sh deploy/fork/updater/install.sh niklas
sudo -n /usr/local/sbin/foundry-deploy status
```

Installation copies the helper and fixed configuration to root-owned paths and adds
only that helper to `/etc/sudoers.d/foundry-deploy`. It does not restart containers.
Never grant sudo to the checkout script itself: the checkout is writable by the agent.
Unrestricted Docker access, including docker-group membership, effectively grants
[root privileges](https://docs.docker.com/engine/install/linux-postinstall/).

Deploy the digest printed by the successful build:

```sh
sudo -n /usr/local/sbin/foundry-deploy deploy sha256:<digest-from-build-summary>
```

The helper only addresses the local Docker socket, project `foundry`, service `main`,
the existing `foundry_foundry-state`/`foundry_foundry-workspaces` volumes and
`foundry_default` network. Main runs as UID/GID 1000 with dropped capabilities and
no-new-privileges. Its only published port is `127.0.0.1:3783`. Caller-supplied Docker
contexts, Compose files, environment variables, image registries and host mounts are
not accepted. Kubernetes, PostgreSQL, Cloudflare and other containers are not updated.

Finish any work in Foundry before updating: Main is briefly stopped. The helper
checks the existing deployment, pulls and validates the image, saves stopped T3 state
under `/var/lib/foundry-deploy/update-*/state.tar`, and replaces only Main. It checks
health, readiness and unchanged environment/instance identities. The manifest records
the previous image ID and candidate revision. Backups contain private state and are
root-readable only; retention is manual. They do not include PostgreSQL or workspaces
and are not a replacement for the complete backups described below.

If backup creation fails, the old container restarts. If candidate startup or identity
verification fails, Main stays stopped and the helper reports the backup directory.
The operator must restore the saved state into the stopped Foundry state volume and
restart the previous image from the manifest after checking migration compatibility.
An image-only automatic rollback could run an older binary against migrated SQLite.
Do not extract the archive into the host root filesystem.

After installing this update path, use the helper for Main updates; running the old
checkout's `compose up` can select its old `FOUNDRY_IMAGE` again. The installed Compose
configuration is intentionally independent of the checkout. This helper supports the
baseline file-backed instance store only and refuses custom `FOUNDRY_*` settings.
Activating PostgreSQL instance storage or Access sessions requires a separately reviewed
configuration/migration step: see [one-time Access activation](access-activation.md)
for the administrator-run transition, recovery procedure and Windows acceptance.
Reinstalling reviewed helper changes is also an owner action.
To revoke the passwordless command, remove `/etc/sudoers.d/foundry-deploy` with sudo.

## Cloudflare Access and initial pairing

DNS, the existing tunnel route, and the Access application are operator-managed. They are not created by Compose. Use the same hostname for the Web UI and API/WebSocket requests. Cloudflare Access authenticates the outer HTTP connection; T3's pairing and permission checks remain enabled inside it.

After completing the Access login, pair the browser with this environment. Generate a fresh one-time pairing link with the bundled CLI:

```sh
docker compose --env-file deploy/fork/.env -f deploy/fork/compose.yml exec main node dist/bin.mjs pair
```

For browser access through the tunnel, replace the local origin in the generated HTTP pairing URL with `https://foundry.heavenforgeprod.com`, preserving its path, query, and fragment. Do not post the token in issues, commits, or logs. If it expires or was consumed, generate another.

Native clients and automated callers cannot assume an interactive Access session. Do not put shared Access service-token secrets in a Web or desktop bundle. Before enabling automated calls, configure an appropriate separate machine endpoint or implement a supported service-auth transport. The revised plan integrates instance login, device discovery, and routing into Main; it does not deploy a separate Connect broker or require Clerk. These capabilities are not implemented yet; current browser pairing reaches only the Main environment. The Windows package's connection through Access has not been validated on a Windows client.

For Cloudflare's machine authentication model, see [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). Access rules must not turn future webhook paths into unauthenticated bypasses; retain connector authentication when those endpoints are implemented.

## Windows builds and public configuration

On Windows x64:

```sh
vp i
vp run foundry:build windows
```

This creates an unsigned `Foundry-*.exe` installer under `release/`. The app ID is `com.heavenforge.foundry`, its URL scheme is `t3foundry`, and it uses separate `.t3-foundry` state and `t3foundry` browser storage. It neither imports the official app's old profile nor enables an official update feed. Signing and automatic updates are deferred.

The Windows package name is `foundry`, so its default installation directory is
`%LOCALAPPDATA%\Programs\foundry`. The installer refuses a saved installation
location outside a directory named `foundry`, including a `/D` override. The withdrawn
P04 preview used `Programs\t3code`; do not run its uninstaller, because that directory
can contain the original T3 installation. Back up both apps' data, repair T3 with its
matching official installer, and inspect the old Foundry registry entries before
removing those entries separately. A new installation must not automatically migrate
or uninstall that shared directory.

The manual Windows build tests installation, reinstallation, rejection of the old
colliding registration and uninstallation alongside a pinned official T3 installer
on an ephemeral GitHub-hosted runner before uploading the artifact. It compares T3
program-file hashes and profile fixtures; it does not establish recovery on an
affected user machine or the interactive P04 login gate.

The [deployment profile](../../deploy/fork/profile.json) supplies the hosted origin and repository. Foundry builds ignore checkout `.env` files. Leave the inherited `T3CODE_RELAY_URL` and Clerk build configuration unset: they belong to the separate Connect deployment that this fork no longer plans to operate. The baseline build keeps Connect disabled; these flags do not implement runtime instance discovery or the new gateway. Analytics and relay trace uploads are disabled for Foundry builds.

## Windows Access transport probe (P04, acceptance pending)

Foundry desktop builds can start an isolated acceptance harness instead of the normal
app. This is not the P05 onboarding flow and does not start a local T3 backend.
Use a build from the reviewed P04 branch and launch its installed executable in
PowerShell with three public values:

```powershell
& 'C:\Path\Foundry.exe' -- --foundry-access-probe 'https://your-foundry.example' 'https://your-team.cloudflareaccess.com' '<expected-instance-uuid>'
```

The first `--` is required on Windows: Electron rejects additional arguments after
a URL unless application arguments follow that separator, exiting before Foundry
can show an error.

Obtain the expected instance ID through a trusted operator connection to the
descriptor, not from an unverified redirect. The probe uses its own
`Foundry-Auth-Probe` Electron profile and a partition bound to origin, issuer and
instance ID. OAuth tokens are encrypted using OS-backed safe storage; plaintext
fallback is refused. Never send OAuth URLs, callback query strings, tokens or the
profile contents as evidence. The normal Foundry/T3 profiles are not imported.

Prerequisites are app-specific Managed OAuth with public-client registration and
loopback callbacks enabled, reachable OAuth/resource endpoints without a browser
challenge for native requests, and P03 configured on Main with its migrated
PostgreSQL store and confirmed operator binding. Discovery must advertise S256,
public clients and registration/token/revocation endpoints on the confirmed issuer.
The probe accepts access-token lifetimes up to 24 hours. It does not disable Access,
alter a WAF policy, copy system-browser cookies or embed a service token.

Use **Sign in** to open the system browser. The callback is bound to an ephemeral
`127.0.0.1` port, state and PKCE; the token is scoped to the instance resource.
The probe checks the pinned descriptor and creates a P03 session. If it reports that
the correct instance was reached but Access sessions are not enabled on Main, only
the outer OAuth/HTTP step succeeded; Foundry authentication and P04 remain unverified.

For full acceptance, **Open instance** uses that same isolated Electron session for
HTTP and WebSocket; existing T3 pairing is still required for the T3 client. The
remote page gets no preload, Node access or desktop bridge. Close that window to
return to the action dialog. Verify session inspection, explicit refresh and reconnect,
expiry, closing/relaunching the probe, and logout. Restoring the encrypted grant first
refreshes it remotely; **Check session** then verifies the persisted Foundry cookie.
Logout clears this partition and its local grant even if remote revocation fails,
but reports that failure rather than claiming complete logout. Test a second instance
and unexpected identity/issuer changes separately. The probe reserves the Authorization header for Managed OAuth. For an ordinary T3
bearer request, it sends that same T3 credential in the instance-advertised T3 session
cookie header for this request only; it does not persist an extra cookie. T3 still
checks the credential, scopes, origin and revocation. The cookie name is read only
after verifying the pinned Foundry descriptor. DPoP and unknown authorization schemes
remain unsupported and are refused rather than weakened.

Focused tests cover the OAuth protocol and request boundary. They do not establish
Google/Cloudflare/Windows compatibility, OS-backed persistence, real WebSocket
behavior or completion of P04. Record those results with the tested build in its PR.

## Instance onboarding (P05, acceptance pending)

Open `/foundry` on the chosen Main origin before T3 pairing. **Verify current
origin** reads the descriptor without following redirects; confirm its instance ID,
origin and issuer against the operator's values, then sign in. HTML/Access challenges
are reported as login requirements. **Check session** and **Refresh session** use the
existing Foundry session endpoints. A saved identity is checked again before each
operation and before constructing the normal T3 connection runtime after a reload.

**Open T3 environment** returns to the existing pairing/connection supervisor.
Foundry sign-in does not supply a T3 bearer, discover devices or authorize a gateway.
Web users can return through **Settings → Connections → Manage instance sign-in**.
The page has no background environment connections or separate reconnect loop.

To switch Web origins, **Sign out and remove** first, then enter the next HTTPS
origin and choose **Open URL**. This revokes the current Foundry session and removes
only its saved identity. Independent T3 pairing/caches and browser Access SSO remain
separate. Failed revocation retains the binding. The explicit **Forget local identity
without revocation** recovery action removes only the local pin and reports that
remote revocation is unconfirmed; it is not a successful logout.

For the isolated Windows instance client, use a Foundry build containing P05:

```powershell
& "$env:LOCALAPPDATA\Programs\foundry\Foundry.exe" -- --foundry-instance
```

The local selector takes the instance URL, operator-confirmed instance UUID and Access
issuer at runtime. It has no preload or Node access. **Sign in** uses P04's existing
system-browser/PKCE transport. **Open instance** opens the Web onboarding page in the
same protected partition. Close that window to return to the native controls for
OAuth refresh or **Remove / switch instance**. Removal closes its windows and
connections, attempts Foundry/OAuth revocation and clears only that identity's
partition, encrypted grant and pin. Failed remote revocation is explicitly reported.
Only one instance is active. `Foundry-Instances` is separate from `Foundry-Auth-Probe`,
the normal Foundry profile and personal T3 profiles; nothing is imported.

This opt-in entry does not replace the normal desktop launcher or the P04 acceptance
probe. Main must also contain P05's additive public origin/issuer descriptor metadata
and Web page; an older Main is reported as unsupported. No native Foundry login is
provided when Access is disabled. Developing this entry does not satisfy the outstanding
Windows P04 tests or authorize deploying a new Main image. Full Web/Windows integration,
restart/expiry/revocation and second-instance isolation still require recorded runtime
acceptance on the matching builds.

## Actions budget

Only **Foundry checks** runs automatically, on PRs. It has one Ubuntu job, cancels superseded runs, and runs `check:changed` with concurrency one. There is no duplicate push build, schedule, platform matrix, mobile lane, or automatic publication. Workflow/manifest changes can make `check:changed` typecheck all packages; this remains a single bounded job.

**Foundry build (manual)** builds one selected target and keeps its artifact for three days. Linux produces an image archive and optionally publishes it to this fork's GHCR when `publish_linux` is selected; Windows produces an installer. Neither deploys. Registry images have separate retention and must be cleaned up deliberately, preserving deployed and recovery digests. The inherited workflows have no automatic triggers; reusable upstream build definitions retain `workflow_call` for compatibility. Keep inherited workflows disabled in repository Actions settings. After an upstream merge, audit any newly introduced triggers before enabling them.

## Backup and recovery

The named volumes are persistence, not an off-host backup. Before treating this deployment as production, choose an external backup destination and retention policy. Back up both PostgreSQL databases (for example, `pg_dump -Fc`), roles, and the private password file separately. Back up the T3 state and workspace volumes with the Main Node stopped so SQLite and its sidecars stay consistent. Preserve repository Git objects required by checkpoints.

For a coordinated restore point, stop new work and the Main Node, take the database dumps and volume snapshots, then resume it. Store a manifest with the image digest/source revision and snapshot time. Restore into separate volumes first, verify the databases and T3 environment, and reconcile external actions before resuming automation. Never run `docker compose down --volumes` on the deployed project as part of an update.

## Instanz-Descriptor (Protokoll 1)

`GET /.well-known/foundry?protocolVersion=1` liefert Instanz-ID, Main-Environment-ID
und die tatsächlich unterstützten T3-Bootstrap-/Session-Verfahren. Der Endpunkt ist
wie die bestehenden Auth-Metadaten ohne T3-Session lesbar; ein vorgeschaltetes Access
bleibt wirksam. Metadaten allein bestätigen weder eine Betreiberanmeldung noch
Gateway-Zugriff. Die optional aktivierbare Foundry-Anmeldung ist unten beschrieben;
Device-Katalog und Gateway folgen separat.

`protocolVersion` muss genau einmal mit `1` vorkommen. Fehlende, leere oder doppelte
Angaben ergeben HTTP 400 (`protocol_version_required`), andere Werte HTTP 409
(`protocol_version_unsupported`). Wiederholbare `capability`-Parameter sind optional;
`requiredCapability` bezeichnet zwingend benötigte Fähigkeiten. Unbekannte optionale
Fähigkeiten werden ignoriert, unbekannte Pflichtfähigkeiten ergeben HTTP 409
(`capability_unsupported`). Die Antwort nennt unterstützte und ausgehandelte
Fähigkeiten; standardmäßig `foundry.instance-descriptor`, bei aktivierter
Access-Anmeldung zusätzlich `foundry.access-sessions`. Antworten sind
nicht cachebar. Bestehende T3-Endpunkte verlangen keine Foundry-Protokollversion.

Im standardmäßigen Dateimodus legt die erste erfolgreiche Anfrage
`userdata/foundry-instance-id` im konfigurierten
T3-Home an. Diese Datei zusammen mit der bestehenden Environment-Identität sichern.
Eine beschädigte Instanz-ID wird nicht automatisch ersetzt (HTTP 503). Der Dateispeicher
veröffentlicht eine vollständig geschriebene ID atomar per Hardlink; das State-Dateisystem
muss Hardlinks unterstützen. Dies ist kein HA- oder Stromausfall-Durabilitätsnachweis.

## PostgreSQL für Instanzdaten

Der Instanzspeicher ist ausdrücklich wählbar: `FOUNDRY_INSTANCE_STORE=file` (Default)
oder `postgres`. Im PostgreSQL-Modus ist `FOUNDRY_INSTANCE_DATABASE_URL` erforderlich.
Eine fehlende Konfiguration verhindert den Start. DB-Fehler führen nie zum Dateispeicher
zurück. Die lokale T3-SQLite-Datenbank bleibt unabhängig.

Vor der erstmaligen Aktivierung Main stoppen, Daten sichern und die Migration mit
**demselben T3-Home** ausführen. Der separate Befehl übernimmt die vorhandene P01-ID
und Main-Environment-ID. Auf einer Neuinstallation legt er zuerst diese lokalen IDs
an. Eine vorhandene DB mit abweichenden IDs wird abgelehnt; ebenso unbekannte Schemas
oder Objekte in `public`. Keine fremden Daten werden entfernt. Die Migration und ihr
Versionsmarker werden unter einer PostgreSQL-Transaktionssperre gemeinsam committed.
Ein erneuter Aufruf ist idempotent. Fehler bei der Migration vor Aktivierung beheben.

Ein Administrator richtet zwei getrennte Rollen auf der dedizierten `fork_connect`
Datenbank ein. Beispiel (nur für eine vorher geprüfte leere Datenbank; die bestehende
NOLOGIN-Owner-Rolle bleibt unverändert):

```sql
CREATE ROLE foundry_instance_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE foundry_instance_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE fork_connect FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE fork_connect TO foundry_instance_migrator;
GRANT CONNECT ON DATABASE fork_connect TO foundry_instance_runtime;
-- In fork_connect:
REVOKE ALL ON SCHEMA public FROM PUBLIC;
```

Zugangsdaten über den geschützten Betriebsweg setzen, nicht in SQL-Dateien oder
Shell-History ablegen. Die Runtime-Rolle darf weder CREATE-/TEMP-Rechte noch
Mitgliedschaft in einer privilegierten oder Schema-Owner-Rolle besitzen. Die Migration
vergibt gezielt Leserechte, Generation-Updates und Schreibrechte für die spätere
Betreiberbindung; sie erstellt **keinen** angemeldeten Betreiber. Die lokale Bindung
und die Session-Verwaltung verwenden dieselbe PostgreSQL-Transaktionsgrenze.

Mit `FOUNDRY_INSTANCE_MIGRATION_URL` ausschließlich im Migrationsprozess:

```sh
node apps/server/src/bin.ts foundry migrate --base-dir /path/to/foundry-home --runtime-role foundry_instance_runtime
```

Im gebauten Server lautet derselbe Einstieg `node dist/bin.mjs foundry migrate ...`.
Danach Main mit `FOUNDRY_INSTANCE_STORE=postgres` und der Runtime-URL starten; die
Migrations-URL gehört nicht in seine Umgebung. Keine automatische Startup-Migration.
Der Pool ist auf vier Verbindungen begrenzt, die Migration auf eine; Verbindungsaufbau
und Statements haben begrenzte Wartezeiten.

`GET /api/foundry/ready` liefert ohne Cache HTTP 200 mit `{"ready":true}` oder HTTP 503
mit `{"ready":false}`. Im PostgreSQL-Modus prüft jede Anfrage Datenbank, Schema 2,
Runtime-Rollenrechte und die Bindung zum Main-Environment. Eine noch vorhandene lokale
P01-ID muss ebenfalls übereinstimmen; bei fehlender Datei wird keine neue ID erzeugt.
Der Instanz-Descriptor verwendet dieselben Prüfungen. Der allgemeine T3-Betrieb und
bestehende direkte Verbindungen werden dadurch nicht zu Foundry-Sessions.

Für Restore PostgreSQL und Main-State zusammen sichern. PostgreSQL ist nach Aktivierung
der autoritative Instanzspeicher. Nicht als Fehlerbehebung auf `file` umschalten:
Das würde die zentralen Zugangs- und Betreiberbindungen umgehen. Schema-Upgrades
benötigen weiterhin einen koordinierten Stop/Migration/Start; kein HA-Betrieb.

Der isolierte Gate-Test benötigt PostgreSQL-17+-Binärdateien und einen unprivilegierten
Linux-Benutzer. Er erzeugt ausschließlich einen temporären Cluster mit privatem
Unix-Socket, testet Migration/Rechte/DB-Ausfall/Neustart und räumt ihn danach auf:

```sh
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin vp run --filter t3 test:foundry-postgres
```

Dieser explizite Integrationstest ergänzt `check:changed`; er wird nicht automatisch
in GitHub Actions gestartet. Er verwendet keine vorhandene Datenbank oder Credentials.

## Cloudflare-Access-Nachweis und Foundry-Sessions

Diese Backend-Anmeldung wird mit `FOUNDRY_ACCESS_ENABLED=true` aktiviert. Sie erfordert
`FOUNDRY_INSTANCE_STORE=postgres`, die Runtime-Datenbank-URL und:

- `FOUNDRY_ACCESS_ISSUER`: exakt `https://<team>.cloudflareaccess.com`, ohne abschließenden Slash.
- `FOUNDRY_ACCESS_AUDIENCE`: der AUD-Tag der vorgesehenen Access-Anwendung.
- `FOUNDRY_PUBLIC_ORIGIN`: die kanonische HTTPS-Origin der Instanz, ohne Pfad oder Slash.

Main vor dem Upgrade stoppen, sichern und `foundry migrate` wie oben ausführen.
Die Migration von Schema 1 auf 2 ergänzt persistente Sessions; Instanz-ID,
Betreiberbindung und Zugangsgenerationen bleiben erhalten. Die neue Runtime verlangt
Schema 2 auch dann, wenn die Access-Anmeldung deaktiviert bleibt. Ein Downgrade auf
den P02-Build ist mit Schema 2 nicht unterstützt.

Vor dem ersten Login den Betreiber einmal lokal mit der Runtime-Datenbank-URL und
dem passenden Home binden:

```sh
node apps/server/src/bin.ts foundry bind-operator --base-dir /path/to/foundry-home --issuer https://example.cloudflareaccess.com --subject <confirmed-subject>
```

Der Subject muss aus einer vertrauenswürdigen Access-/IdP-Zuordnung stammen; eine
E-Mail-Adresse oder ein Anzeigename ersetzt ihn nicht. Wiederholung mit denselben
Werten erhält die interne Betreiber-ID. Eine abweichende Bindung wird abgelehnt;
Account-Wechsel und Wiederherstellung sind kein Selbstregistrierungsweg. Der
Readiness-Endpunkt prüft weiterhin die Datenbank-/Identitätsgrundlage; ein noch
ungebundener Betreiber wird beim Login ausdrücklich abgewiesen.

Bei aktivierter Konfiguration nennt der Descriptor zusätzlich `instanceAuth` und
`foundry.access-sessions`. Die folgenden Endpunkte verwenden alle POST, exakt die
konfigurierte `Origin` und `Content-Type: application/json`; sie benötigen keinen
Request-Body:

| Endpunkt                    | Zweck und zusätzliche Nachweise                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `/api/foundry/auth/login`   | Signierten `Cf-Access-Jwt-Assertion` prüfen und Session ausgeben                                |
| `/api/foundry/auth/session` | Aktuelle Session und CSRF-Token für den Client lesen                                            |
| `/api/foundry/auth/refresh` | Gültige Session, CSRF-Token und erneut gültigen Access-Nachweis prüfen; Session atomar ersetzen |
| `/api/foundry/auth/logout`  | Session mit CSRF-Nachweis dauerhaft entwerten und Cookie löschen                                |

Session, Instanz-/Betreiber-ID, Ablaufzeit in Unix-Millisekunden und CSRF-Token werden
als JSON zurückgegeben; der Session-Schlüssel ausschließlich als Cookie
`__Host-foundry_session` mit Secure, HttpOnly, SameSite=Strict und Path=/.
Erneuerung und Logout senden den CSRF-Token im Header `X-Foundry-CSRF`.
Nach einem Reload kann der Client ihn über den Session-Endpunkt erneut lesen.
Antworten werden nicht gecacht. Fehler sind strukturierte Codes: HTTP 401 für
ungültige Nachweise/Sessions, 403 für Origin-/CSRF-/Betreiberfehler und 503 bei
fehlender Datenbank- oder Schlüsselverfügbarkeit.

Eine Session gilt höchstens 15 Minuten und niemals über den Ablauf des geprüften
Access-Nachweises hinaus. Erneuerung macht den vorherigen Schlüssel ungültig; bei
parallelen Erneuerungen gewinnt genau eine Anfrage. Clients müssen diese Operation
serialisieren und bei verlorener Antwort gegebenenfalls neu anmelden. Logout bleibt
nach Neustarts wirksam. Cloudflare-SSO und direkte T3-Sessions haben eigene Logout-Wege;
ein weiterhin gültiger Access-Nachweis kann einen neuen Foundry-Login ermöglichen.

Der Server prüft RS256-Signatur, Issuer, Audience, Subject, Application-Typ und
Zeitgrenzen. Signaturschlüssel kommen ausschließlich vom konfigurierten Team-Endpunkt
`/cdn-cgi/access/certs`, mit begrenztem Cache und ohne Redirect-Verfolgung.
Ungeprüfte E-Mail-/Forwarding-Header schaffen keinen Zugang. PostgreSQL speichert nur
Hashes der Session-Schlüssel und bindet Sessions an Instanz, Betreiber, Audience und
Zugangsgenerationen. Jede Prüfung liest den aktuellen DB-Zustand; DB-Ausfall sperrt
Zugriffe. Ein Access-Widerruf wird ohne zusätzliche Introspektion spätestens mit dem
begrenzten Session-Ablauf wirksam; lokale Generationserhöhungen wirken sofort auf
nachfolgende Prüfungen.

Die Sessions berechtigen bisher die Foundry-Auth-Endpunkte. Windows-Anmeldefenster,
Client-Onboarding und Gateway-Zugriff folgen in eigenen Paketen. Diese Implementierung
ändert weder Cloudflare-Regeln noch bestehende T3-Authentifizierung. Vor produktiver
Freigabe bleibt die echte Access-/Windows-Abnahme aus G1 erforderlich.

### Optionaler RPC-Streamtransport (P09-Backend)

Der zusätzliche Main-Schalter `FOUNDRY_STREAM_GATEWAY_ENABLED=true` setzt die P08-HTTP-Gateway-Schalter voraus. Der Connector benötigt zusätzlich zu `--gateway-origin` ausdrücklich `--streams`. Er verbindet ausschließlich den lokalen `/ws`-Endpunkt mit eigener kurzlebiger DPoP-Session. Der Descriptor bewirbt nur mit diesem Schalter `foundry.rpc-streams`. Gemeinsame Clients können einen expliziten Foundry-Verbindungstyp über den vorhandenen Connection-Supervisor öffnen. Der Web-Adapter verwendet ausschließlich die bestätigte Foundry-Session derselben Origin; eine persönliche T3-Verbindung wird bei gleicher Environment-ID nicht ersetzt. Der optionale Device-Katalog ist in den Verbindungseinstellungen erreichbar; die integrierte Replay-/Terminal-Abnahme bleibt offen.

Nach einem expliziten Grant liefert POST `/api/foundry/gateway/grants/ticket` ein einmaliges Gateway-Ticket und ein vorhandenes T3-RPC-Socket-Ticket. Beide werden bei GET `/api/foundry/gateway/stream` zusammen mit der aktuellen Orchestrierungs-Protokollversion geprüft; bei schlüsselgebundener T3-Session bleibt ein frischer DPoP-Nachweis für diese öffentliche URL erforderlich. Die erlaubten Grant-Scopes sind `orchestration:read`, optional `orchestration:operate`, `terminal:read` und `terminal:operate`; sie dürfen die authentifizierte Client-Session nicht überschreiten. Der P08-Projektlistenadapter behält lokal ausschließlich Read-Rechte.

Daten laufen über eigene ausgehende Worker-Sockets zu `/api/foundry/devices/stream`; der Device-Steuerkanal trägt nur die Öffnungsnachricht. Bei der späteren Access-Integration muss der separat autorisierte Machine-Zugang auch diesen Pfad erlauben; der Connector ändert keine Access-Policy. Grenzen: vier Streams pro Device, 32 insgesamt, 128 ausstehende Client-Tickets; Ticket-/Verbindungsaufbau zehn Sekunden, Grants höchstens 60 Sekunden, blockierter Schreibvorgang fünf Sekunden. Im aktivierten Main gilt für alle WebSocket-Nachrichten ein Limit von 256 KiB, auch für unabhängige direkte T3-Sockets desselben Prozesses. Die Datenstrecke begrenzt außerdem gelesene Batches und ausstehende Schreibdaten auf 256 KiB. Größere RPC-Antworten schließen die Verbindung; es gibt noch keine Fragmentierungszusage für beliebig große Snapshots.

Verlust des Steuerkanals beendet seine Datenverbindungen. Laufende Streams prüfen Grants/Sessions und Device-Generation vor jeder Weitergabe sowie spätestens beim nächsten sekündlichen Check. Abbruch, Ablauf und Überlast schließen die Strecke; transportseitig wird weder eine Mutation noch eine Terminaleingabe wiederholt. Lokale Sessions werden beim Schließen widerrufen. Ereignisgesteuerter Widerruf und Erneuerung gehören zu den folgenden Client-/P11-Arbeiten. Produktive Aktivierung und reale Windows-/Access-/Maschinenabnahme sind damit nicht freigegeben; Nachholstand siehe [Issue #13](https://github.com/niklaskastning/foundry/issues/13).

Foundry-Verbindungen handeln bei jedem Verbindungsaufbau nach erneuter Identitätsprüfung einen neuen Grant und neue Socket-Tickets aus. Direkte Alternativrouten und vom Worker gemeldete Adressen werden nicht als Umgehung des Main verwendet. Der vorhandene Supervisor übernimmt Reconnect; unary RPCs werden nicht erneut gesendet. Geht die Bestätigung einer Terminaleingabe verloren, meldet der Client ausdrücklich, dass sie die Shell erreicht haben könnte. Direkte Datei-/Medien-HTTP-Anfragen bleiben für diesen Verbindungstyp gesperrt; signierte Assets nutzen den unten beschriebenen Chunk-Transport. Die Foundry-Anmeldung allein stellt weiterhin keinen Device-Zugang her: Der bestehende Main-Endpunkt verlangt zusätzlich eine T3-Session mit den angefragten Scopes.

### Begrenzte Worker-Dateiübertragung

Worker mit `assetChunkTransfer` im T3-Descriptor unterstützen signierte Asset-Reads und Attachment-Uploads in RPC-Chunks über denselben P09-Datenkanal. Der gemeinsame Client lädt signierte Assets darüber und die Web-/Desktop-Upload-Queue nutzt denselben Kanal. Es gibt keine neue HTTP-Proxy-Route oder aktive Projekt-Preview an der Main-Origin; die interaktive Device-Auswahl folgt in P12. Datei-Reads übernehmen die bestehenden signierten Asset-Grenzen. `filesystem:read` kann ausdrücklich im Foundry-Grant angefragt werden, sofern die Main-Session diesen Scope besitzt; Schreibrechte auf das allgemeine Dateisystem folgen daraus nicht.

Grenzen: 32 KiB Binärdaten pro Chunk, 16 MiB pro Datei, vier gleichzeitige Reads und vier zugelassene Chunk-Schreibanfragen. Unvollständige Uploads liegen in einem eigenen temporären Worker-Verzeichnis, höchstens 32 Uploads und insgesamt 64 MiB reservierte Dateigröße. Nur bestätigte Offsets dürfen fortgesetzt werden; identische Wiederholungen sind idempotent, abweichende Bytes/Hashes werden abgewiesen. Veröffentlichung erfolgt erst nach vollständigem SHA-256-Abgleich über den bestehenden unveränderlichen Attachment-Speicher.

Resume gilt während des Worker-Prozesses und der bestehenden zehnminütigen Upload-URL-Gültigkeit. Nach Worker-Neustart ist der bestätigte Teilstand null; vollständige bereits veröffentlichte Attachments bleiben erhalten und werden nicht überschrieben. Entfernen eines Pending-Attachments über RPC entfernt auch dessen Teilstand. Abgelaufene Teilstände werden bei der nächsten Upload-Operation bereinigt; das temporäre Verzeichnis wird beim regulären Server-Ende entfernt. Der Client hält eine noch gültige Upload-URL nur im Speicher und nur für dasselbe Verbindungsziel; nach einem Fehler fragt er vor weiteren Chunks den bestätigten Offset ab. Nach Client-Neustart beginnt ein neuer Upload. Die vorhandene Upload-Queue reagiert auf den Connection-Supervisor; es gibt keine zweite Reconnect-Steuerung.

HTML-Downloads werden lokal als `text/plain` mit opaker Data-Origin dargestellt, SVGs als opake Data-URLs; andere Medien erhalten ausschließlich bekannte passive MIME-Typen, unbekannte Dateien `application/octet-stream`. Blob-URLs gehören der jeweiligen Asset-Abfrage und werden bei deren Ende oder Verbindungsverlust widerrufen. Kein Fallback lädt Foundry-Dateien aus einer persönlichen lokalen T3-Umgebung. Textdateien und Checkpoint-Diffs nutzen ihre bestehenden RPCs mit einem Foundry-Leselimit von 16 KiB; größere Antworten werden mit der bestehenden Trunkierungsanzeige begrenzt. Vollständige signierte Datei-Downloads bleiben bis 16 MiB möglich.

Durchgehende Main-/Client-Integration, Browser-Nachweis der Content-Isolation und Windows-Abnahme bleiben in [Issue #13](https://github.com/niklaskastning/foundry/issues/13) offen.

### Device-Freigaben und aktive Gateway-Sessions

Instanzschema 5 trennt `clientAccess`, `automationExecution` und `sandboxProvisioning` pro Device mit eigener Generation. Die Migration erhält den bisherigen Client-Zugang registrierter, nicht widerrufener Devices; neue Enrollments erhalten nur `clientAccess`. Automation und Sandbox-Provisionierung bleiben deaktiviert und können über die API nicht freigegeben werden. Die Device-Registrierung und ihr dauerhafter Widerruf bleiben getrennt von dieser wiedererteilbaren Client-Freigabe.

Am bestehenden Gateway sind POST `/api/foundry/gateway/grants/readAccess` (`deviceId`) und `/api/foundry/gateway/grants/updateAccess` (`deviceId`, `kind: "clientAccess"`, `enabled`, aktuelle `generation`) verfügbar. Beide benötigen die bestätigte Foundry-Session, Origin/CSRF und eine Main-T3-Session mit `access:write`. Jede erfolgreiche Änderung erhöht die Generation; ein veralteter Schreibstand wird abgewiesen. Die Verbindungseinstellungen bieten die interaktive Bedienung bei beworbener Capability `foundry.device-catalog`. Bestehendes `/remove` entfernt dagegen nur einen kurzlebigen Gateway-Grant dieser Client-Session.

Gateway-Grants verwenden jetzt Protokoll 2 mit `grantKind` und `accessGeneration`; Client, Main und Connector müssen aus passenden Builds stammen. Main prüft die aktuelle PostgreSQL-Freigabe beim Erteilen und Verwenden eines Grants sowie vor jedem Datenframe. Im Leerlauf wird einmal pro Sekunde geprüft. Eine hängende Stream-Autorisierungsprüfung wird nach zwei Sekunden abgebrochen; das Schließen der beiden Enden wartet höchstens fünf weitere Sekunden. Es gibt keinen unbegrenzt gültigen Autorisierungscache. Entzug oder Wiedererteilung invalidieren alte Generationen; andere Grant-Arten und unabhängige direkte T3-Sessions bleiben erhalten. Der Connector widerruft seine lokale DPoP-Session beim Ende des Streams; bei Verbindungsverlust begrenzt zusätzlich deren Ablauf die Gültigkeit. Kein versprochener Fern-Kill eines offline laufenden Agenten oder externer Provider-Tokens.

Migration und Widerruf sind auf isoliertem Zustand zu prüfen, nicht als Image-only-Upgrade/-Downgrade gegen das aktive Deployment. Die noch fehlende integrierte Windows-/Browser-/Mehrmaschinen-Abnahme bleibt in [Issue #13](https://github.com/niklaskastning/foundry/issues/13) erfasst.

### Device-Auswahl im Client (P12)

Mit aktiviertem Stream-Gateway bewirbt Main zusätzlich `foundry.device-catalog`. Nach bestätigter Instanzanmeldung und einer Main-T3-Session öffnet `/settings/connections` den Katalog. `Refresh devices` liest den aktuellen Stand; die Liste behält Offline-Geräte. Die Auswahl öffnet vorhandene Projekt-/Threadansichten über Main, ohne weiteres Pairing je Client/Device. Sie bleibt innerhalb dieses Browser-Tabs gespeichert; Wechsel und Trennen verwenden die bestehende Connection-Registry. Nach dem Trennen gibt es keinen automatischen Rückfall auf die direkte Main-Verbindung. Bereits gespeicherte persönliche T3-Verbindungen werden nicht überschrieben.

Die Liste erfordert `orchestration:read`, Verwaltung zusätzlich `access:write`. Client-Zugriff lässt sich auch offline entziehen und erneut freigeben; `Revoke registration` beendet die Registrierung dauerhaft. Für eine neue Maschine zuerst mit der vorhandenen CLI den öffentlichen Device-Request erstellen, dessen Environment-ID und Public Key in den Einstellungen bestätigen und die kurzlebige Approval-Datei sicher zur Maschine übertragen. Der private Device-Schlüssel bleibt dort. Automation und Sandbox-Ausführung sind keine Katalogaktionen.

Vor einem Instanzwechsel führt `Manage instance sign-in` den lokalen Disconnect samt Registry-Aufräumen aus. Andere Clients behalten ihre eigene Auswahl, verlieren aber bei serverseitigem Entzug gemäß P11 den Zugriff. Die sichtbare Liste wird ausdrücklich aktualisiert; der Connection-Supervisor bleibt die einzige Reconnect-Steuerung.

Der Cookie-Adapter setzt weiterhin die Main-Origin voraus: Web und das remote geladene P04-Desktopfenster verwenden dieselbe Oberfläche. Eine normale lokale Desktop-Shell erhält dadurch noch keinen Auth-Adapter für fremde Origins. Die reale Zwei-Client-/Windows-Abnahme und UI-Aufnahmen stehen weiterhin aus; siehe [Issue #13](https://github.com/niklaskastning/foundry/issues/13).
