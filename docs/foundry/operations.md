# Foundry on the Linux VPS

Foundry serves the shared Web client and T3 backend at `http://127.0.0.1:3783`. The existing host `cloudflared` service should route `foundry.heavenforgeprod.com` to that origin. Keep Cloudflare Access enabled for this hostname, including HTTP and WebSocket paths. Do not expose port 3783 or PostgreSQL publicly.

This is the isolated base deployment, not the planned instance gateway, Automation engine, or host worker. The backend still uses its own local SQLite state. PostgreSQL has empty `fork_automation` and `fork_connect` databases reserved for their separate future migrations. No application receives the database administrator credential. Owner roles cannot log in; runtime and migration logins are provisioned with the services that need them.

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

The [deployment profile](../../deploy/fork/profile.json) supplies the hosted origin and repository. Foundry builds ignore checkout `.env` files. Leave the inherited `T3CODE_RELAY_URL` and Clerk build configuration unset: they belong to the separate Connect deployment that this fork no longer plans to operate. The baseline build keeps Connect disabled; these flags do not implement runtime instance discovery or the new gateway. Analytics and relay trace uploads are disabled for Foundry builds.

## Actions budget

Only **Foundry checks** runs automatically, on PRs. It has one Ubuntu job, cancels superseded runs, and runs `check:changed` with concurrency one. There is no duplicate push build, schedule, platform matrix, mobile lane, or automatic publication. Workflow/manifest changes can make `check:changed` typecheck all packages; this remains a single bounded job.

**Foundry build (manual)** builds one selected target and keeps its artifact for three days. Linux produces an image archive; Windows produces an installer. Neither publishes nor deploys. The inherited workflows have no automatic triggers; reusable upstream build definitions retain `workflow_call` for compatibility. Keep inherited workflows disabled in repository Actions settings. After an upstream merge, audit any newly introduced triggers before enabling them.

## Backup and recovery

The named volumes are persistence, not an off-host backup. Before treating this deployment as production, choose an external backup destination and retention policy. Back up both PostgreSQL databases (for example, `pg_dump -Fc`), roles, and the private password file separately. Back up the T3 state and workspace volumes with the Main Node stopped so SQLite and its sidecars stay consistent. Preserve repository Git objects required by checkpoints.

For a coordinated restore point, stop new work and the Main Node, take the database dumps and volume snapshots, then resume it. Store a manifest with the image digest/source revision and snapshot time. Restore into separate volumes first, verify the databases and T3 environment, and reconcile external actions before resuming automation. Never run `docker compose down --volumes` on the deployed project as part of an update.

## Instanz-Descriptor (Protokoll 1)

`GET /.well-known/foundry?protocolVersion=1` liefert Instanz-ID, Main-Environment-ID
und die tatsächlich unterstützten T3-Bootstrap-/Session-Verfahren. Der Endpunkt ist
wie die bestehenden Auth-Metadaten ohne T3-Session lesbar; ein vorgeschaltetes Access
bleibt wirksam. Metadaten allein bestätigen weder eine Betreiberanmeldung noch
Gateway-Zugriff. Es gibt noch keinen Foundry-Login oder Device-Katalog.

`protocolVersion` muss genau einmal mit `1` vorkommen. Fehlende, leere oder doppelte
Angaben ergeben HTTP 400 (`protocol_version_required`), andere Werte HTTP 409
(`protocol_version_unsupported`). Wiederholbare `capability`-Parameter sind optional;
`requiredCapability` bezeichnet zwingend benötigte Fähigkeiten. Unbekannte optionale
Fähigkeiten werden ignoriert, unbekannte Pflichtfähigkeiten ergeben HTTP 409
(`capability_unsupported`). Die Antwort nennt unterstützte und ausgehandelte
Fähigkeiten; derzeit ausschließlich `foundry.instance-descriptor`. Antworten sind
nicht cachebar. Bestehende T3-Endpunkte verlangen keine Foundry-Protokollversion.

Die erste erfolgreiche Anfrage legt `userdata/foundry-instance-id` im konfigurierten
T3-Home an. Diese Datei zusammen mit der bestehenden Environment-Identität sichern.
Eine beschädigte Instanz-ID wird nicht automatisch ersetzt (HTTP 503). Der Dateispeicher
veröffentlicht eine vollständig geschriebene ID atomar per Hardlink; das State-Dateisystem
muss Hardlinks unterstützen. Dies ist kein HA- oder Stromausfall-Durabilitätsnachweis.

P02 muss die vorhandene ID unverändert und transaktional in die Instanzdatenbank
übernehmen, abweichende vorhandene DB-Identitäten ablehnen und danach PostgreSQL als
autoritativen Speicher hinter `InstanceIdentityStore` verwenden. Bei DB-Ausfall darf
kein Rückfall auf eine neue lokale Identität erfolgen. Diese Migration ist noch nicht
implementiert; lokale T3-SQLite-Daten bleiben unabhängig.
