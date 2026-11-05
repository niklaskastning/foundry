# Foundry on the Linux VPS

Foundry serves the shared Web client and T3 backend at `http://127.0.0.1:3783`. The existing host `cloudflared` service should route `foundry.heavenforgeprod.com` to that origin. Keep Cloudflare Access enabled for this hostname, including HTTP and WebSocket paths. Do not expose port 3783 or PostgreSQL publicly.

This isolated Main serves the instance registry, gateway, confirmed artifacts and thread archives. Instance PostgreSQL uses `fork_connect` with its own migrations; local T3 state remains in the separate SQLite store. Automation retains its separate database/migrations and requires the explicit activation described below. No application receives the database administrator credential. Owner roles cannot log in; the migration login stays disabled outside an explicit migration. The dedicated host worker is managed separately.

## Development-VPS authorization

For this VPS, [the maintainer's standing agent instructions](../../AGENTS.md#development-vps-and-agent-autonomy) authorize deployment of tested PR heads before merge or user acceptance, task-related migrations and necessary resets of disposable Foundry test data. They override older requirements for a separate development-deployment approval in this runbook and the activation guides; production acceptance gates remain separate. User `niklas` has passwordless sudo for task-related operations; use `sudo -n`. The restricted helper below remains the preferred Main image-update path, but it is not the limit of the agent's authorized privileges on this host. Credentials, personal T3 state and unrelated services are outside the test-data reset permission.

## Experimental device enrollment (P06)

Für einen realen Device-/Gateway-Versuch zuerst den [begrenzten G2-Aktivierungsablauf](g2-activation.md)
lesen: Machine-Access, Worker-Isolation und der begrenzte Main-Konfigurationsübergang
sind eigene Voraussetzungen. Die folgenden Einzelbefehle erteilen keine Aktivierungsfreigabe.

Der separate Linux-Host-Dienst hat einen [eigenen Installer und Betriebsweg](../../deploy/fork/worker/README.md). Er wird nicht durch Main-Deployment oder Device-Enrollment installiert; seine reale Dienstkonto-/G2-Abnahme bleibt offen.

This opt-in backend registers a device key and its first local environment. It does
not connect that environment, provide gateway access or install an agent. The
outstanding release gates and follow-up work are tracked in the
[guardrails plan](basic-leitplanken.md#bestehende-nachweise-und-offene-technische-abnahmen). Do not activate it
on the existing production deployment as part of development testing.

Use an isolated Main with PostgreSQL instance schema **7**, the existing operator
binding, and the configured `FOUNDRY_PUBLIC_ORIGIN`. Run the existing
`foundry migrate` command with the migration role before starting this source
version; it upgrades schemas 1/2/3/4/5/6 while preserving instance identity, operator and
sessions. Older binaries reject schema 7: an image-only downgrade is not
a recovery procedure. The runtime role cannot change device keys or enrollment
expiry. Set `FOUNDRY_DEVICE_ENROLLMENT_ENABLED=true` explicitly alongside
`FOUNDRY_ACCESS_ENABLED=true` to expose `/api/foundry/devices/enroll` and advertise
`foundry.device-enrollment`; the route and capability are absent by default.
This mode does not implement native authentication.

The P38a artifact-store foundation is separately disabled by default. In an isolated
Main, `FOUNDRY_ARTIFACTS_ENABLED=true` requires the complete stream-gateway profile
and creates private `userdata/foundry-artifacts/{pending,blobs}` inside the existing
state volume. Keep that directory and instance PostgreSQL in the same coordinated
backup/recovery boundary. It exposes bounded JSON transfer operations at
`POST /api/foundry/artifacts` for existing dual-authenticated clients and
`POST /api/foundry/devices/channel` for signed device requests; the existing GET
channel is unchanged. No Cloudflare machine-path expansion is needed. Descriptor
support uses optional `artifactTransfer` metadata: adding an unknown capability to
the strict version-1 enum would break older Windows readers. The separate opt-in
[worker binding](../../deploy/fork/worker/README.md#zentrale-artefakte-p38a)
confirms attachments before message commit. P38b also reconciles the local
event journal with the central thread archive. When the artifact profile is enabled, `/foundry` shows Files after a
verified session. Load files there without selecting or connecting their source
device; a Main T3 session with `orchestration:read` remains required. Confirmed
thread attachments use the same Main read path. HTML/SVG open as escaped source,
and Blob URLs remain scoped to their viewer. The native Access sign-in probe does
not host the file library; its existing Windows download block remains separate.
Automated client coverage does not complete the live acceptance gate.

For a reviewed schema-6 image on a schema-5 Docker deployment, the administrator uses
`activate-access.py upgrade-artifacts sha256:<digest> <source-sha>` to migrate
schema 5 to 6 with a coordinated database/state/workspace backup. This leaves the
artifact profile disabled. Once the reviewed Main image is verified,
`activate-access.py artifacts enable` changes only the private runtime flag,
restarts Main and verifies schema, identity and transfer metadata. It saves the
previous configuration and restores it if startup or verification fails; if
recovery cannot be verified, Main stays stopped. No general sudo grant is added.
The `update` command preserves schema 5, 6 or 7 and the enabled profile.

Disable publication on workers before `activate-access.py artifacts disable`.
This retains confirmed metadata and blobs. The helper refuses to disable the
gateway while artifacts remain enabled. A schema upgrade failure still requires
the coordinated restore procedure; a profile change is not a schema downgrade.
Development builds alone may explicitly use HTTP on loopback for the artifact
client, matching local instance verification; deployed clients require HTTPS.

With schema 7, `/foundry` also lists confirmed thread archives after session
verification. Open a thread and load further history as needed; messages, tool
details, recorded decisions and confirmed attachments come from Main even when
the source device is unavailable or removed. This view has no live terminal or
writer actions. Incomplete history and missing resources stay explicitly marked.

P38b uses instance schema 7 for central thread events, confirmed cursors and artifact
references. Automation keeps its separate database and migrations. Upgrade an
existing schema-6 Main with `activate-access.py upgrade-archive sha256:<digest>
<source-sha>`; the helper holds the deployment lock through migration and
verification and records the coordinated previous database/state/image recovery.
An older schema-6 image alone cannot recover a schema-7 deployment. Same-schema
`update` and profile changes retain schema 7. Worker credentials and local T3
state remain on the worker; archive ingestion never copies an active SQLite file.

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
For a restricted deployment account, do not grant sudo to the checkout script itself: the checkout is writable by the agent. This restriction does not describe `niklas`, whose broader development-host privileges are documented above.
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

The updater already serializes runs with `/var/lib/foundry-deploy/lock` (an exclusive, nonblocking `flock`). Manual Foundry rollouts, worker updates and migrations use the same lock through verification. Do not acquire it again around the updater or bypass a busy lock. The manifest and `success` file provide automatic evidence; briefly report previous/target revision, healthcheck result and recovery path in the PR or handoff. Manual paths report the same fields there, without a separate file or checklist.

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

Native clients and automated callers cannot assume an interactive Access session. Do not put shared Access service-token secrets in a Web or desktop bundle. Foundry sessions, device discovery and the authenticated Worker gateway are implemented in Main. Interactive gateway access currently requires both a Foundry session and a Main T3 session; selecting a Worker does not require separate device pairing. The gateway forwards approved thread, terminal and file-read scopes, but does not yet forward `settings:write`. A single central login that supplies all authorized user capabilities is still incomplete. Unattended Automation uses its explicit binding and current grant generations rather than reviving a browser session. Windows session evidence and remaining acceptance gaps are tracked separately in the implementation plan.

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

Instanzschema 5 trennt `clientAccess`, `automationExecution` und `sandboxProvisioning` pro Device mit eigener Generation. Die Migration erhält den bisherigen Client-Zugang registrierter, nicht widerrufener Devices; neue Enrollments erhalten nur `clientAccess`. Automation wird getrennt über die Device-Einstellungen oder den lokalen Betreiberbefehl freigegeben; Sandbox-Provisionierung bleibt gesperrt. Die Device-Registrierung und ihr dauerhafter Widerruf bleiben getrennt von dieser wiedererteilbaren Client-Freigabe.

Am bestehenden Gateway sind POST `/api/foundry/gateway/grants/readAccess` (`deviceId`) und `/api/foundry/gateway/grants/updateAccess` (`deviceId`, `kind: "clientAccess"`, `enabled`, aktuelle `generation`) verfügbar. Beide benötigen die bestätigte Foundry-Session, Origin/CSRF und eine Main-T3-Session mit `access:write`. Jede erfolgreiche Änderung erhöht die Generation; ein veralteter Schreibstand wird abgewiesen. Die Verbindungseinstellungen bieten die interaktive Bedienung bei beworbener Capability `foundry.device-catalog`. Bestehendes `/remove` entfernt dagegen nur einen kurzlebigen Gateway-Grant dieser Client-Session.

Gateway-Grants verwenden jetzt Protokoll 2 mit `grantKind` und `accessGeneration`; Client, Main und Connector müssen aus passenden Builds stammen. Main prüft die aktuelle PostgreSQL-Freigabe beim Erteilen und Verwenden eines Grants sowie vor jedem Datenframe. Im Leerlauf wird einmal pro Sekunde geprüft. Eine hängende Stream-Autorisierungsprüfung wird nach zwei Sekunden abgebrochen; das Schließen der beiden Enden wartet höchstens fünf weitere Sekunden. Es gibt keinen unbegrenzt gültigen Autorisierungscache. Entzug oder Wiedererteilung invalidieren alte Generationen; andere Grant-Arten und unabhängige direkte T3-Sessions bleiben erhalten. Der Connector widerruft seine lokale DPoP-Session beim Ende des Streams; bei Verbindungsverlust begrenzt zusätzlich deren Ablauf die Gültigkeit. Kein versprochener Fern-Kill eines offline laufenden Agenten oder externer Provider-Tokens.

Migration und Widerruf sind auf isoliertem Zustand zu prüfen, nicht als Image-only-Upgrade/-Downgrade gegen das aktive Deployment. Die noch fehlende integrierte Windows-/Browser-/Mehrmaschinen-Abnahme bleibt in [Issue #13](https://github.com/niklaskastning/foundry/issues/13) erfasst.

### Device-Auswahl im Client (P12)

Mit aktiviertem Stream-Gateway bewirbt Main zusätzlich `foundry.device-catalog`. Nach bestätigter Instanzanmeldung und einer Main-T3-Session öffnet `/settings/connections` den Katalog. `Refresh devices` liest den aktuellen Stand; die Liste behält Offline-Geräte. Die Auswahl öffnet vorhandene Projekt-/Threadansichten über Main, ohne weiteres Pairing je Client/Device. Sie bleibt innerhalb dieses Browser-Tabs gespeichert; Wechsel und Trennen verwenden die bestehende Connection-Registry. Nach dem Trennen gibt es keinen automatischen Rückfall auf die direkte Main-Verbindung. Bereits gespeicherte persönliche T3-Verbindungen werden nicht überschrieben.

Die Liste erfordert `orchestration:read`, Verwaltung zusätzlich `access:write`. Client-Zugriff lässt sich auch offline entziehen und erneut freigeben; `Revoke registration` beendet die Registrierung dauerhaft. Für eine neue Maschine zuerst mit der vorhandenen CLI den öffentlichen Device-Request erstellen, dessen Environment-ID und Public Key in den Einstellungen bestätigen und die kurzlebige Approval-Datei sicher zur Maschine übertragen. Der private Device-Schlüssel bleibt dort. Automation wird getrennt freigegeben und benötigt weiterhin die explizite Main-Konfiguration; Sandbox-Ausführung ist keine Katalogaktion.

Vor einem Instanzwechsel führt `Manage instance sign-in` den lokalen Disconnect samt Registry-Aufräumen aus. Andere Clients behalten ihre eigene Auswahl, verlieren aber bei serverseitigem Entzug gemäß P11 den Zugriff. Die sichtbare Liste wird ausdrücklich aktualisiert; der Connection-Supervisor bleibt die einzige Reconnect-Steuerung.

Der Cookie-Adapter setzt weiterhin die Main-Origin voraus: Web und das remote geladene P04-Desktopfenster verwenden dieselbe Oberfläche. Eine normale lokale Desktop-Shell erhält dadurch noch keinen Auth-Adapter für fremde Origins. Die reale Zwei-Client-/Windows-Abnahme und UI-Aufnahmen stehen weiterhin aus; siehe [Issue #13](https://github.com/niklaskastning/foundry/issues/13).

### Worker-Ausführungs-Lease und Ergebnis (P16)

Worker mit `foundryWorkerLifecycle` erfassen vor dem Provider-Start eine lokale,
dauerhafte Ausführung in ihrer eigenen T3-SQLite-Datenbank. Nach `workerLaunch`
liefert `workerRead` unter `lifecycle` Generation, Ablauf, Writer-Nachweis und
Ergebnismanifest. Der Auftraggeber erneuert die 60-Sekunden-Lease mit
`foundry.workerRenew` und genau dieser Generation rechtzeitig vor Ablauf;
Read/Follow und eine offene Gateway-Verbindung erneuern sie nicht. Erneuerung
benötigt wie Start/Cancel `orchestration:operate`. Eine abgelaufene Lease lässt
sich nicht wiederbeleben. Die Device-Kanal-Generation ist davon unabhängig.

Der lokale Watchdog fordert bei Ablauf den Abbruch ausschließlich des ursprünglichen
Runs an. Nach Neustart bleiben nicht bestätigte Ausführungen `uncertain`; ein Retry
findet denselben Auftrag und eröffnet keinen Ersatz-Writer. Auch ein bestätigter
Cancel-Request oder ein terminaler T3-Run ist kein Writer-Nachweis. Vor dem Eintritt
in den Provider verhindert eine dauerhafte Startsperre die Ausführung; danach prüft
der Codex-Adapter den nativen Zustand samt bekannten Unteragenten und vollständigen
Befehlsdaten. Fehlende/unerreichbare Nachweise halten die Ausführung gesperrt.
Ein untätiger Provider-Server darf weiterleben. Andere Adapter liefern derzeit
keinen positiven Abschlussnachweis für diesen Worker-Pfad.

Ein erfolgreiches Manifest verlangt zusätzlich den passenden `ready`-Checkpoint
und dessen vorhandene Git-Referenz. Ein fertiger Agent mit offenem oder ungültigem
Checkpoint bleibt `finalizing`; normale T3-Finalisierung/Capture bleiben zuständig.
Ein bestätigter Abbruch kann ein `stopped`-Manifest ohne Checkpoint liefern; dieses
ist kein erfolgreiches Arbeitsergebnis. Bereits gespeicherte Manifeste sind
unveränderlich. Bei älteren Aufträgen ohne Ausführungsdatensatz wird kein Nachweis
nachträglich erfunden.

Auf aktivierten Workern mit Provider-Bindung schützt `foundry-workspaces.sqlite` im Worker-State die
verwalteten Checkout-Pfade. Worker-Launch reserviert vor Thread-Anlage und bindet
Command, Thread und Ausführungs-Generation dauerhaft. Manuelle Turns in denselben
Wurzeln reservieren vor Setup-Skripten und Provider-Eintritt denselben Writer-Platz.
Ein konkurrierender Start wird abgewiesen; ein Neustart beseitigt die Sperre nicht.
Die Freigabe verlangt das generationgebundene P16-Manifest beziehungsweise bei
manuellen Turns einen terminalen Run mit positivem nativem Writer-Nachweis. Fehlt
bei einem Adapter dieser Nachweis, bleibt sein Checkout reserviert. Unklare
abgebrochene Vorbereitungen bleiben ebenfalls gesperrt; Journaldateien nicht zur
Freigabe löschen. Das schützt verwaltete Agentenstarts, keine beliebigen Host-Prozesse
oder manuell ausgeführten Terminalbefehle.

Worker mit Capability `foundryManagedWorkspaces` unterstützen die Reservierungsbindung.
Ungebundene Worker behalten ihren bisherigen interaktiven Betrieb, etwa für kostenlose
Replay-Prüfungen; Foundry-Launch verlangt weiterhin die gesonderte Provider-Bindung.
`foundry.workerLaunch` akzeptiert dort optional `workspaceMode: "worktree"` für einen
eigenen verwalteten Worktree. Dafür muss eine erlaubte Wurzel das Quellrepository
enthalten; Worktrees werden nicht innerhalb ihres Quell-Checkouts erzeugt. Ohne
Option bleibt der Checkout-Modus erhalten. Beide Modi benutzen dasselbe dauerhafte
Journal pro Worker. Die reale G3-Abnahme ist im [Leitplanken-Plan](basic-leitplanken.md#bestehende-nachweise-und-offene-technische-abnahmen)
mit Evidence in PR #45 festgehalten. Die Factory-Aktivierung bleibt gesondert.

## Automation-Persistenz, manueller Start und Steuerung (P18a/P18b/P47/P19–P21/P49)

`apps/server/src/automation/` speichert gepinnte Runs und Definitionen. P19 ergänzt
einen standardmäßig deaktivierten Scheduler im bestehenden Main-Prozess. Das
Anlegen eines `pending`-Runs erteilt keine Ausführungsfreigabe.
Sie verwendet einen eigenen `AutomationDatabase`-Pool und den schemaqualifizierten
Namespace `foundry_automation` mit eigenem Migrationsmarker. Für spätere Aktivierung
ist eine separate Automation-Datenbank mit eigenen Migrator-/Runtime-Rollen
vorzusehen; weder Instanz-Migrator noch lokales T3-SQLite werden dafür verwendet.
Die Automation-Migration verändert keine Instanzobjekte. Sie verlangt eine Runtime
ohne DDL-/Owner-Rechte und vergibt keine UPDATE-/DELETE-Rechte auf Versionen oder
Command-Receipts. Der Migrator bleibt außerhalb des späteren Runtime-Prozesses.

Repository-Schlüssel sind hier opake Bindings einer unveränderlichen Version,
keine Dateipfade oder Zugriffsrechte. P47 liefert das gemeinsame Definitionsformat;
P18a speichert noch keine Workflow-DSL, Credentials oder Grants. Ein Create-Retry
muss dieselbe globale Command-ID und denselben Inhalt verwenden. Er liest die
vorhandene Entität einschließlich ihres aktuellen fachlichen Zustands.

Archivieren sperrt neue Starts, erhält Aufträge/Versionen und beendet keine Runs.
`Workflows.start` verwendet `Factories.withStartEligibility` und speichert Command,
Run und Outbox innerhalb derselben Automation-Transaktion. Ein identischer Retry
liest den vorhandenen Run auch nach Archivierung; neue Starts bleiben gesperrt.
Externe Ausführung folgt ausschließlich nach dem Automation-Commit.
WorkItem-Abschluss wird ausdrücklich fachlich gesetzt, unabhängig von Run-Erfolg.
Schema 2 erweitert vorhandene P18a-Daten ohne Instanz-/T3-Migration. Factory- und
Workflow-Version sowie Repository und Eingaberevision bleiben am Run gepinnt;
die Revision ist ein opaker Eingabestand, kein verifiziertes Git-Objekt. Die
geordnete Step-Liste unterstützt Agent, Test, Approval und Publish; Referenzen
dürfen nur auf vorherige Steps zeigen. Test-IDs sind konfigurierte Prüfungen,
keine im Backend auszuwertenden Skripte. Die Runtime darf Versionen, Run-Snapshots und ursprüngliche Outbox nicht ändern
oder löschen. Schema 4 ergänzt getrennte, gezielt beschreibbare Dispatchzustände,
Attempts und Zustell-Outbox. `readRun` projiziert daraus den aktuellen Zustand.

P47 ergänzt in Schema 3 unveränderliche Definitions-Snapshots und einen aktiven
Versionszeiger. Der gemeinsame Validator in `@t3tools/shared/factoryDefinition`
verarbeitet einen expliziten Dateibaum, liest keine Host-Pfade und wird auch vom
späteren Formulareditor verwendet. Einstieg ist `factory.yaml`:

```yaml
schemaVersion: 1
factoryId: existing-factory
repositories: [existing-repository-binding]
workflows:
  - id: main
    file: workflows/main.yaml
```

Die Workflow-Datei enthält `steps` nach dem P18b-Schema. Weitere Ressourcen,
Credential-Werte und Grants sind nicht Bestandteil dieses Formats. Dateipfade
sind relativ, ohne Parent-Segmente, URLs oder Backslashes; alle referenzierten
Dateien müssen mitgeliefert werden. Maximal 101 Dateien, 256 KiB je Datei und
2 MiB insgesamt, auch nach kanonischem Export. YAML-Aliasse und unbekannte Felder
werden abgewiesen. Die Validierung liefert Datei und Feldpfad, keine Quellwerte
in Fehlermeldungen.

Die Aktivierung verlangt die erwartete aktive Basisversion und eine bestehende
Factory-Version als Repository-Freigabe; Definitionen dürfen deren Scope nur
einschränken. Command, vollständiger Snapshot, neue Factory-/Workflow-Versionen
und aktiver Zeiger werden gemeinsam committet. Hashes beziehen sich auf die
kanonische Semantik, Herkunft wird separat gespeichert. Ein identischer Retry
liest seine ursprüngliche Revision auch nach späteren Aktivierungen. Eine alte
Version wird für neue Starts durch Export und erneute Aktivierung mit aktuellem
Basisabgleich wiedergewählt; bestehende Runs bleiben gepinnt. Definitionsaktivierung
startet keine Ausführung.

Für Git-Definitionen erhält `foundry-github-app` einen gesonderten Repository-Eintrag
mit `purpose: "definitions"`; dieser erlaubt ausschließlich Definitionslesen mit
`contents:read`, kein Issue-Polling oder Publishing. Die GitHub-App-Installation
muss das Repository ebenfalls freigeben. Änderungen erhöhen die Konfigurationsgeneration;
bestehende Quellbindungen verlangen anschließend ausdrückliche Reautorisierung.

Unter Factory → Definition das Definitionsrepository, seine numerische ID, Branch
und Verzeichnis binden. Bei bestehenden lokalen Definitionen wird die aktuelle
Version samt Inhaltshash als Importbasis festgehalten. Die erste Git-Aktivierung
verlangt gleiche Inhalte und unveränderte Basis. Bei Drift die Dateien im Repository
angleichen oder ausdrücklich die aktuelle lokale Version als neue Importbasis wählen.
Nach der Übernahme bleibt Git dauerhaft Owner; lokale Aktivierungsbefehle werden
abgewiesen. Änderungen erfolgen per PR im Definitionsrepository.

Synchronisierung liest und validiert einen konkreten Commit, aktiviert ihn aber nicht.
Quelle und Revisionen zeigen Fehler, Dateien und Diff zur aktiven Version. Erst die
explizite Aktivierung übernimmt die geprüfte Revision für neue Runs. Ein Rollback
aktiviert eine frühere gültige Git-Revision mit aktuellen Rechten; bestehende Runs
behalten ihren Snapshot. Hintergrundlesen lässt sich auch nach einem Rechtewiderruf
pausieren. Betriebsbindungen und Trigger bleiben unabhängig in der App bedienbar.

Der isolierte Nachweis verwendet ausschließlich einen temporären PostgreSQL-Cluster,
keine vorhandenen Datenbanken oder persönlichen Provider-Zugänge:

```sh
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin vp run --filter t3 test:automation-postgres
```

### P19 gezielt aktivieren

Die Factory-Ansichten bieten manuelle Starts, Run-Steuerung und eine persönliche
Inbox. Fachliche Fehler werden nicht automatisch wiederholt; Publish-Steps besitzen
eine revisionsgebundene Entscheidung, aber noch keinen GitHub-Publish-Adapter.
Es gibt genau einen konfigurierten Worker und höchstens einen aktiven Run darauf.

Vor Aktivierung eine separate Automation-Datenbank mit eigenem Migrator und
Runtime-Benutzer bereitstellen. Die Runtime braucht weder DDL noch Migrator-Login.
Migration erfolgt ausdrücklich mit `FOUNDRY_AUTOMATION_MIGRATION_URL` aus geschützter
Konfiguration und `foundry automation-migrate --database <bestätigte-datenbank>
--runtime-role <automation-runtime>`. Der Befehl prüft den Datenbanknamen und verweigert
ein vorhandenes Instanzschema. Er startet keine Runs. Auf der Entwicklungs-VPS gilt
der gemeinsame Deployment-Lock; Instanzschema 7 und lokales T3-SQLite bleiben getrennt.

Die Main-Runtime verlangt bei `FOUNDRY_AUTOMATION_ENABLED=true` zusätzlich:

- `FOUNDRY_AUTOMATION_DATABASE_URL`: separater Runtime-Pool, Schema 7;
- `FOUNDRY_AUTOMATION_TARGET`: JSON mit genau `deviceId`, `environmentId` und
  `allowedRunIds` (explizite eigene Fixture-Runs, höchstens 100);
- den vorhandenen Gateway-/Artefaktbetrieb sowie eine bewusst erteilte
  `automationExecution`-Device-Freigabe zusätzlich zu `clientAccess`.

Die Automation-Freigabe ist in Connections getrennt von Client-Zugang sichtbar.
Kein Flag, allgemeines Capability-Bit oder Deployment aktiviert bestehende Runs.
Ein Produktstart speichert eine ausdrückliche, dauerhafte Zulassung zusammen mit
Run und Receipt; er erfordert eine aktuell aktive Definition und explizite
Projekt-/Workerbindung. Die P19-Allowlist bleibt ausschließlich für den begrenzten
Fixture-Enroll-Pfad bestehen.

Auf der Entwicklungs-VPS aktiviert der geprüfte Betreiberpfad das Profil nach dem
Image-Update ausdrücklich:

```sh
sudo -n python3 -I deploy/fork/updater/activate-access.py automation enable <device-id> <environment-id>
```

Er sperrt den bestehenden Deployment-Lock, verifiziert die eigene leere
`fork_automation`, provisioniert getrennte Rollen, migriert auf Schema 5 und schaltet
den Migrator wieder auf NOLOGIN. Die Automation-Freigabe wird über denselben
DeviceGrants-Service mit erwarteter Generation vergeben. Das Profil konfiguriert
genau diesen Worker mit leerer Fixture-Allowlist. Bestehende Runs werden nicht
zugelassen. Keine Credentials in Shell-Argumente oder Logs übernehmen.

Das `automation-*/manifest.json` hält vorheriges Profil und Grant fest. Fehler stellen
das Profil sowie den früheren Freigabewert mit neuer Generation wieder her;
nicht bestätigbare Recovery lässt Main gestoppt. Die separate migrierte Datenbank
bleibt inaktiv. Bei späteren Updates gehört sie zum Recovery-Bundle; Schema 5 darf
nicht durch einen reinen Image-Downgrade auf Schema-4-Code zurückgesetzt werden.

Der aktive Entwicklungsstand wird von Automation-Schema 7 auf 8 über denselben
intern sperrenden Betreiberpfad aktualisiert:

```sh
sudo -n python3 -I deploy/fork/updater/activate-access.py upgrade-automation sha256:<image-digest> <source-sha>
```

Dieser Pfad verlangt das aktive Schema-7-Profil, stoppt Main, sichert zusätzlich die
separate Automation-Datenbank und migriert sie mit dem Zielimage. Der Migrator wird
anschließend wieder gesperrt. Bei Fehlschlag umfasst Recovery auch diese Datenbank;
kein Image-only-Downgrade. Der Aufruf aktiviert keine Trigger. Für spätere Updates
innerhalb Schema 8 bleibt `update` der passende Pfad.

### Wiederverwendbare Rollen und Startvorgaben

Definitionsschema 2 ergänzt `roles`, `skills` und `defaults` in `factory.yaml`.
Ein Agent-Step behält seinen konkreten `prompt` und kann eine `role`, zusätzliche
`skills` und `execution`-Overrides referenzieren. Schema 1 bleibt für bisherige
Prompt-Workflows verfügbar. Rollen und Skills werden mit der gesamten aktivierten
Definition versioniert; Sync allein verändert keine laufende Arbeit.

Beispiel für einen gemeinsamen Rollen-/Skillkatalog in `factory.yaml`:

```yaml
schemaVersion: 2
factoryId: example
repositories: [app]
defaults:
  provider: codex
  model: <Modell-ID aus dem Worker-Katalog>
roles:
  - id: engineer
    name: Engineer
    description: Änderungen umsetzen und prüfen
    instructions: Bewahre vorhandenes Verhalten und erläutere die Verifikation.
    skills: [verification]
    execution:
      options:
        reasoningEffort: low
skills:
  - id: verification
    name: Verification
    instructions: Führe passende Prüfungen aus und berichte ihre tatsächlichen Ergebnisse.
workflows:
  - id: implement
    file: workflows/implement.yaml
  - id: investigate
    file: workflows/investigate.yaml
```

Beide Workflow-Dateien können dieselbe Rolle verwenden. Beispielsweise enthält
`workflows/implement.yaml`:

```yaml
steps:
  - id: implement
    kind: agent
    dependsOn: []
    role: engineer
    prompt: Setze den Auftrag um.
```

Der Untersuchungsworkflow ergänzt stattdessen seinen konkreten Analyseauftrag.
Die verwendete Modell-ID und Reasoning-Stufe müssen vom Worker angeboten werden.

Die Ausführung löst Einstellungen in der Reihenfolge Definitionsdefaults → Rolle →
Step auf. Nicht gesetzte Modelle verwenden die ausdrücklich bestätigte
Betriebsbindung. Unterstützt sind Codex, das Modell und `options.reasoningEffort`.
Skill-Instruktionen werden aus dem aktivierten Snapshot in den Auftrag übernommen;
es werden keine Repository-Dateien überschrieben. Dateibasierte Skill-Bundles,
MCP-/Connector-Ressourcen, Secret-Ausgabe und weitere Provideradapter sind nicht
Teil dieses Schnitts. Unbekannte Felder oder fehlende Referenzen verhindern die
Aktivierung. Git-Dateien erteilen keine Betriebsrechte.

Unter **Agents & skills** stehen Rollen, Skills, wirksame Step-Einstellungen und
der Änderungsweg zum Definitionsrepository. **Overview** zeigt offene Arbeit,
Entscheidungen und letzte Runs. Beim Auftrag lassen sich Worker-Projekt,
Fallback-Modell, Prüfkommandos und Artefaktanforderungen einmal pro Factory und
Repository speichern. Dafür ist Verwaltungsrecht erforderlich; Speichern startet
keinen Run und ersetzt keine aktuelle Worker-/Sessionfreigabe. Jeder Start zeigt
seine Einstellungen, bestehende Runs behalten ihre gespeicherten Requests.

Main benötigt weiterhin Instanzschema 8, Automation jetzt Schema 9. Zuerst den
getesteten Worker mit dem vorhandenen Worker-Updater installieren, dann Main mit
dem intern sperrenden Migrationspfad aktualisieren:

```sh
sudo -n python3 -I deploy/fork/updater/activate-access.py upgrade-factory-agents sha256:<digest> <commit>
```

Der Worker meldet `roleExecutionVersion: 1`; ältere Worker erhalten keine
Rollenaufträge. Der Main-Updater hält die Deploymentsperre, sichert den vorherigen
Stand, migriert bei gestopptem Main und sperrt den Migrator anschließend wieder.
`manifest.json` und `success` im ausgegebenen Recovery-Verzeichnis bleiben der
Betriebsnachweis. Recovery auf Schema-8-Code verlangt den koordinierten vorherigen
Daten-/State-Stand; kein reiner Image-Downgrade. Updates innerhalb Schema 9 nutzen
wieder `update`. Windows-Bedienung und weitere Provider benötigen eigene Abnahmen.

### Versionierte Factory-HTTP-API (P58a)

Bei aktivierter Automation stehen dieselben Benutzeroperationen unter
`/api/foundry/v1/automation/` zur Verfügung. Alle Aufrufe verwenden `POST` mit
JSON. `contract` liefert den maschinenlesbaren Vertrag mit Eingabe- und
Ausgabe-JSON-Schemas; `query`, `command`, `control`, `inbox/query`, `inbox/mark`,
`triggers/query` und `triggers/command` rufen dieselben Services wie die UI auf.
Die bisherigen UI-Endpunkte bleiben erhalten.

Benutzeroperationen benötigen weiterhin die bestehende Foundry-Benutzersitzung samt
Origin/CSRF-Nachweis und eine gültige Main-T3-Sitzung mit den jeweiligen Scopes.
Der bestehende authentifizierte Clienttransport muss diese Nachweise liefern;
ein gewöhnlicher unauthentifizierter `fetch` genügt nicht. DPoP wird für die
tatsächlich aufgerufene URL erstellt. Der unten beschriebene Maschinen-Lesezugang
ist davon getrennt; ein Factory-MCP-Endpunkt besteht noch nicht. Interaktive Cookies
nicht in CI übernehmen; T3-MCP- und Worker-Credentials werden nicht in Benutzerrechte
übersetzt.

Beispielkörper für `query`:

```json
{ "op": "factories", "search": "example", "limit": 20 }
```

Der nächste Seitenaufruf verwendet `after` aus dem zurückgegebenen `next`.
Für typisierte TypeScript-Nutzung stehen Eingabe-/Ausgabe-Schemas in
`AutomationApiOperations` aus `@t3tools/contracts` bereit; derselbe Vertrag
liegt der HTTP-Dekodierung zugrunde. Keine zusätzliche SDK-Laufzeit ist nötig.

Mutation und Command-ID vor dem Senden speichern. Nach verlorener Antwort exakt
dieselbe Anfrage wiederholen; eine neue Command-ID wäre eine neue Entscheidung.
Revisionskonflikte verlangen erneutes Lesen. Ein Start bestätigt Annahme, keinen
erfolgreichen Run; eine Rückgabe erzeugt weiterhin einen pausierten Folgelauf.
Inbox-Markierungen sind keine Freigaben und Definitionsaktivierung startet keinen Run.

Antworten werden nicht gecacht. Fehler enthalten nur `code`: HTTP 400 bei
ungültiger Eingabe, 403 bei fehlendem Recht, 404 bei fehlendem Objekt, 503 bei
nicht verfügbarem Service und 409 bei fachlichen Konflikten oder Sperren.
Unbekannte API-Versionen führen keine Operation aus. Die API begrenzt JSON-Körper
auf 3 MiB; die engeren fachlichen Größenlimits bleiben zusätzlich wirksam.

### Begrenzter Maschinen-Lesezugang

Unter demselben API-Präfix verwalten `credentials/issue`, `credentials/list` und
`credentials/revoke` eigenständige Credentials. Verwaltung verlangt eine gültige
Foundry-/T3-Benutzersitzung mit `access:write`, Ausgabe zusätzlich
`orchestration:read`. `issue` nimmt eine vor dem Senden gespeicherte UUID `id`,
`label`, eine explizite Liste vorhandener `factoryIds` (1–32) und `expiresAt`
(Unix-Millisekunden, höchstens 30 Tage in der Zukunft) an. Der einzige Scope ist
`automation:read`; Wildcards und Schreibscopes werden nicht angenommen.

Die erste Antwort enthält `credential` und `token`. Das Token sicher speichern;
PostgreSQL hält nur seinen Hash. Exakte Wiederholung derselben ID und Eingabe
liefert dieselben Metadaten, aber `token: null`. Ein verlorenes Token lässt sich
nicht auslesen: alte ID widerrufen und ausdrücklich mit neuer ID ausstellen.
Geänderte Eingaben unter derselben ID ergeben 409, auch nach Ablauf/Widerruf.
`list` nimmt `{}` an und zeigt höchstens 100 Einträge, alle aktuell gültigen zuerst,
danach zuletzt ablaufende inaktive. Höchstens 100 Credentials dürfen gleichzeitig
gültig sein. `revoke` nimmt `{ "id": "<credential UUID>" }` an; Wiederholung ist
sicher, die Antwort ist `null`. Credential-Verwaltung bietet noch keine eigene UI.

Maschinen senden das Token als `Authorization: Bearer <token>` an `contract` oder
`query`. Zulässige Abfragen sind `factories`, `factory`, `workItems`, `workItem`,
`runs`, `run`, `attempts` und `attempt`. Listen filtern vor der Pagination auf die
freigegebenen Factories; Run-/Attempt-Zugriffe prüfen zusätzlich den Betreiber.
Jeder Aufruf prüft Ablauf, Widerruf und Instanz-/Betreibergeneration erneut.
Benutzer-Logout beendet diese eigenständigen Credentials nicht. Ein Maschinen-Token
wird auch bei zusätzlich vorhandenen Benutzer-Cookies nicht zum Schreibzugang.

Der Zugang umfasst weder Start/Steuerung noch Handoff, Inbox, Trigger, einzelne
Definitionsdateien oder Live-Worker-/Archivzugriff. Vorhandene T3-MCP-Tokens werden
nicht zu Foundry-Credentials. Factory-MCP und seine Instruktionsevals folgen separat.

Ein vorgeschaltetes Access muss den nicht interaktiven API-Zugang zusätzlich erlauben.
Der bestehende Device-Service-Zugang gilt nicht automatisch für diese API-Pfade.
Dieses Upgrade verändert keine Access-/Domainregeln; eine Loopback-Probe belegt
keinen öffentlichen CI-Zugang.

Main benötigt Instanzschema 8; Automation bleibt bei Schema 8. Den getesteten
unveränderlichen Build mit dem bestehenden Updater aktivieren:

```sh
sudo -n python3 -I deploy/fork/updater/activate-access.py upgrade-machine-credentials sha256:<digest> <commit>
```

Der Helfer hält die bestehende Deploymentsperre, sichert den bisherigen Stand und
migriert bei gestopptem Main. `manifest.json` und `success` im ausgegebenen
Recovery-Verzeichnis festhalten. Ein Downgrade auf Schema-7-Code benötigt den
koordinierten Daten-/State-Restore bei gestopptem Main; kein reiner Image-Rollback.
Nachfolgende Updates desselben Schemas verwenden wieder `update`.

### Auftrag interaktiv übernehmen und zurückgeben (P51)

Im Run zunächst pausieren und das bestätigte Writer-Ende abwarten. Unter „Take over
in T3“ den Quellversuch und vorhandenen Workspace, Alternativbranch oder
Archiv-Wiederherstellung wählen. Der neue verknüpfte Thread startet keinen Turn
von selbst. Er benötigt weiterhin die aktuelle Foundry-/T3-Sitzung und die
bestehenden Worker-Rechte. Im Thread führt „Back to work item“ zum Auftrag zurück.

Vor der Rückgabe Änderungen committen und laufende Turns beenden. Beim Auftrag
Prüfbericht und offene Punkte angeben und „Return to factory“ auslösen. Erst nach
Writer-Ende, Checkpoint, Bundle- und Archivbestätigung entsteht ein pausierter
Folgelauf desselben Auftrags mit neuer Revision und derselben Workflow-Version.
Diesen ausdrücklich fortsetzen; der alte Run bleibt gesperrt. Der Bericht ist eine
Benutzerangabe und ersetzt keine Workflow-Prüfung oder Freigabe. Git-Definitionen
werden durch die Rückgabe nicht geändert oder aktiviert.

Eine unbestätigte Entscheidung mit der gespeicherten Anfrage wiederholen, auch
nach Neuladen. Bei blockierter Rückgabe erlaubt „Reopen interactive work“ weitere
Bearbeitung, solange der Worker die Rückgabe noch nicht finalisiert hat. Danach
kann nur die ursprüngliche Rückgabe zentral bestätigt werden. Fehlende Archive
oder veränderte Workspaces blockieren sichtbar; ein Thread-Archiv allein ersetzt
kein gesichertes Git-Bundle. Technische Fehler während des Öffnens halten die
Sperre bis zur ausdrücklichen Wiederholung nach Behebung der Ursache.

Während eines Handoffs bleibt der eine konfigurierte Worker für diesen Auftrag
reserviert, auch zwischen interaktiven Turns. Worker-Updates verweigern offene
Handoffs. P51 erweitert das lokale Reservierungsjournal; ein älteres Worker-Binary
darf dessen Sperren nicht ignorieren. Die erste Rückkehr auf den vorherigen Stand
benötigt deshalb eine geprüfte Wiederherstellung der gesicherten Worker-Daten,
keinen reinen Konfigurationswechsel. Main-Recovery umfasst Automation-Schema 8.

### GitHub- und Zeitplan-Eingänge

Unter Factory → Triggers zunächst eine inaktive Bindung an die aktive Definition,
das Repository und ein ausdrücklich ausgewähltes Worker-Projekt speichern. Erst
„Authorize and activate“ erteilt unbeaufsichtigte Ausführung. Diese Autorisierung
enthält keine alte Benutzersession; Device-, Client-Access- und Automation-Generationen
werden weiterhin aktuell geprüft. Pause behält oder verwirft wartende Eingänge nach
Auswahl, Widerruf sperrt die Bindung. Die technische Eingangshistorie ist getrennt von
der persönlichen Inbox für Entscheidungen und Fragen.

GitHub-Polling verwendet ausschließlich die zentrale GitHub-App-Verbindung
`github-app`, eine erlaubte numerische Repository-ID und ein ausdrückliches Opt-in-Label.
Bestehende Issues werden bei Aktivierung als Baseline angenommen, ohne Runs zu starten.
Pro Binding-Generation und Issue entsteht höchstens ein fachlicher Start; spätere
Kommentare oder Inhaltsänderungen erzeugen keinen weiteren. Polling kann kurzlebige
Label-/Ereignisfolgen zwischen Abfragen nicht rekonstruieren.

Die App-Konfiguration liegt im vorhandenen Main-SecretStore unter
`foundry-github-app`: App-ID, Installation-ID, privater Schlüssel, Grant-Generation
und erlaubte Repositories mit numerischer ID, `owner/name`, Factory-Bindungsschlüssel
und Basisbranch. Der Betreiber installiert die App ausschließlich in ausgewählten
Repositories mit Issues lesen, Contents schreiben und Pull requests schreiben
(Metadata lesen). Keine persönlichen `gh`-Tokens in die Runtime übernehmen.
Private Schlüssel als PEM mit erhaltenen Zeilenumbrüchen über das Secret-Verfahren
liefern; vor Übernahme die Signaturfähigkeit der Node-Laufzeit prüfen. Niemals in Chat,
Befehlsargumenten oder Logs ausgeben. Änderungen der Autorisierung erhöhen die Generation; Entfernen der
Konfiguration sperrt den Zugang. Eine allgemeine Provider-/MCP-Verwaltung ist nicht enthalten.

Publishing benötigt einen sauberen Commit nach bestätigtem Writer-Ende, passende
Checkpoint-Tree-Identität, zentral bestätigte Artefakte und erfolgreiche konfigurierte
Checks im isolierten Checkout genau dieses Commits. Check-Kommandos müssen ihre
Dependencies dort selbst bereitstellen. Die Freigabe bindet Run-Revision und
Ergebnisstand; sie ist keine allgemeine Push-Erlaubnis. Main überträgt das verifizierte
Git-Bundle und reconciliert den PR über den dauerhaften Operationsschlüssel. Der
Publish-Step führt weder Merge noch Deployment aus.

Zeitpläne verwenden lokale Uhrzeit, Wochentage und eine explizite IANA-Zeitzone.
Nicht existierende DST-Uhrzeiten entfallen; doppelte Uhrzeiten gelten nur beim ersten
Vorkommen. Der erste Termin liegt nach Aktivierung. Verpasste Termine werden verworfen,
nur zuletzt oder begrenzt (höchstens zehn) nachgeholt; der gespeicherte Cursor springt
anschließend in die Zukunft. Ein Zähler dokumentiert ausgelassene Terminbereiche.
Überlappende Runs warten oder werden gemäß Bindung übersprungen. Bestehende T3 Scheduled
Tasks bleiben getrennt und dürfen nicht zusätzlich denselben Workflow starten.

Für einen bereits über P18/P47 angelegten und freigegebenen Run nimmt der interne
Service beziehungsweise `POST /api/foundry/automation/dispatch` den Vorgang
`{op:"enroll",input:{factoryId,runId,projectId,model,checks,requiredArtifacts}}`
entgegen. Er benutzt eine aktuelle Foundry- und T3-Session mit den bestehenden
Scopes; keine Maschinen-Credentials als Benutzerlogin. `checks` bindet Test-IDs
an ausdrücklich vorgegebene `prompt`, exakten nativen `command` und absolutes `cwd`.
`requiredArtifacts` nennt pro `stepId` erforderliche Dateinamen. Doppelte Bindungen
werden abgewiesen. `{op:"read",factoryId,runId}` liest den dauerhaften Zustand.
Dies ist ein begrenzter Entwicklungsanschluss, kein öffentlicher Trigger oder MCP-API.

Die Bindung pinnt Provider-Modell, Projekt, Device- und Grant-Generationen sowie
bestehende Sessionreferenzen. Sie speichert keine Credentials und verlängert keine
Anmeldung. Logout, Refresh, Ablauf oder Widerruf blockieren weitere Zugriffe und
Lease-Erneuerungen; die lokale Worker-Lease bleibt maßgeblich. P19 ersetzt dabei
keinen Writer. Wiederaufnahme benötigt aktuelle Benutzerautorisierung; alte Session- oder Grant-Generationen werden nicht wiederbelebt.

Der Scheduler findet offene Arbeit nach Neustart aus PostgreSQL wieder. Claims
werden vor Worker-/Archivzugriff committet; abgelaufene Claimgenerationen dürfen
keine Ergebnisse bestätigen. Verlorene Antworten verwenden dieselbe Command-ID,
Anfrage, Worker-Generation und denselben Thread. `complete=true` ist ausschließlich
eine Archivbestätigung. Erfolg verlangt zusätzlich Writer-Ende, passenden nativen
Run, Checkpoint, finalen Archivcursor und erforderliche Ergebnisdaten. Ein Test
braucht einen eindeutig passenden abgeschlossenen nativen Command mit Exitcode 0;
fehlendes CWD oder reine Agentenaussagen sind kein Nachweis. Andere Provider als
die nachweisfähigen Adapter bleiben dadurch konservativ unbestätigt.

Codeübergaben bleiben auf demselben expliziten Checkout: Der Worker vergleicht einen
frischen Snapshot unter der Reservation mit dem Vorgänger-Checkpoint, ohne Restore.
Erforderliche Artefakte werden vollständig mit Hash geprüft und vor dem Folgestart
über P38a als echte Anhänge materialisiert. Ein lokaler Git-SHA ersetzt diese
Übergabe nicht. Archive über 10.000 Ereignisse warten sichtbar mit
`archive_result_limit`; P19 lädt keine unbegrenzt großen Resultate in Main.

Gezielte Nachweise, jeweils ausschließlich gegen eigene temporäre PostgreSQL-Cluster:

```sh
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin vp run --filter t3 test:automation-postgres
(cd apps/server && FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin node scripts/test-automation-session-reference.ts)
```
