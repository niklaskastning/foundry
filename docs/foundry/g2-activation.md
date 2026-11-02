# G2: begrenzte Device-/Gateway-Aktivierung

Dieser Ablauf bereitet einen betreiberfreigegebenen G2-Versuch vor. Er ist keine
Aktivierungsfreigabe und ersetzt weder G1-Access noch die Windows-Abnahme.
Aktuelle SHAs, Ergebnisse und offene Gates gehören in [Issue #13](https://github.com/niklaskastning/foundry/issues/13).
Native Foundry-Anmeldung ist noch nicht implementiert; Access abzuschalten ist
kein alternativer Anmeldeweg.

## Voraussetzungen und Konfigurationsgrenze

Main benötigt Schema 5, den vorhandenen PostgreSQL-Runtime-Zugang, unveränderte
Instanz-/Environment-ID und Betreiberbindung sowie die bestehende Access-Konfiguration.
Für den vollständigen Katalog-/HTTP-/RPC-Versuch sind zusätzlich genau diese
Schalter vorgesehen; jeder setzt seinen Vorgänger voraus:

```dotenv
FOUNDRY_DEVICE_ENROLLMENT_ENABLED=true
FOUNDRY_DEVICE_CHANNEL_ENABLED=true
FOUNDRY_GATEWAY_GRANTS_ENABLED=true
FOUNDRY_HTTP_GATEWAY_ENABLED=true
FOUNDRY_STREAM_GATEWAY_ENABLED=true
```

Der letzte Schalter aktiviert auch den Device-Katalog. Es gibt keinen zusätzlichen
Katalog-Schalter. Er begrenzt außerdem direkte T3-WebSocket-Nachrichten desselben
Main-Prozesses auf 256 KiB. Die Aktivierung betrifft deshalb auch dessen bestehende
Clients; große Snapshots müssen in der Abnahme berücksichtigt werden.

**Vor produktiver Änderung ist ein eigener Konfigurationsübergang erforderlich:**
`activate-access.py status/update` akzeptiert aktuell exakt die sechs bisherigen
Access-/PostgreSQL-Variablen. Zusätzliche Flags werden als Drift abgewiesen.
Der alte `foundry-deploy` unterstützt bereits die Access-Grundkonfiguration nicht.
Keinen dieser Prüfer umgehen oder die private Runtime-Datei einfach ergänzen.
Ein Folge-PR muss den begrenzten Übergang samt Inventarisierung, koordiniertem
Backup, Rücknahme und Fehlertests ergänzen. Auch danach startet erst der Betreiber
den freigegebenen Versuch. Keine Migration, kein neues Image allein wegen eines
Mergecommits, kein `--remove-orphans`.

## Maschinenzugang durch Cloudflare

Zur gesonderten Freigabe vorgeschlagen: pfadspezifische Self-hosted-Access-Anwendung
auf derselben bestehenden Domain, ausschließlich für:

| Pfad auf `foundry.heavenforgeprod.com` | Verwendung                   | Innere Foundry-Prüfung                                         |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| `/api/foundry/devices/enroll`          | POST der signierten Freigabe | Schlüssel, kurzlebiges Enrollment, Instanz und Environment     |
| `/api/foundry/devices/channel`         | ausgehender WSS-Steuerkanal  | signierte Challenge, Registrierung und Generation              |
| `/api/foundry/devices/stream`          | ausgehender WSS-Datenkanal   | einmaliges Stream-Ticket aus dem authentifizierten Steuerkanal |

Policy-Aktion **Service Auth**, Include ausschließlich ein dedizierter Service Token
für diesen Testworker, mit begrenzter Laufzeit. Kein Bypass, Everyone oder
Service-Token-Allow auf der gesamten Domain. Die bestehende Benutzeranwendung,
ihr AUD, Google-Login und Managed OAuth bleiben unverändert. Insbesondere
`/api/foundry/auth/*`, `/api/foundry/gateway/*`, `/ws` und die Descriptoren erhalten
keine Maschinenfreigabe. Keine neue Domain, DNS-Route oder Worker-Portfreigabe.

Cloudflare priorisiert spezifischere Anwendungspfade, ohne die Elternpolicy zu
erben. Deshalb muss der Betreiber die drei Pfade und bestehende Überlappungen
prüfen. Token-ID/-Secret werden als `CF-Access-Client-Id` und
`CF-Access-Client-Secret` bei jedem Maschinenrequest übermittelt; ein interaktiver
Browserlogin beweist diesen Weg nicht. Siehe
[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
und [Pfadpriorität](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

Vor Freigabe prüfen, ob der vorhandene Tunnel selbst Access-JWTs auf das AUD der
Benutzeranwendung einschränkt: eine neue Pfadanwendung kann dann trotz Edge-Erfolg
am Tunnel scheitern. Nicht die JWT-Prüfung global abschalten; eine nötige Änderung
mit konkreter Ist-Konfiguration separat vorlegen. Ebenso HTML-403/Redirects durch
WAF/Bot-Regeln gesondert diagnostizieren, statt Access global zu lockern.

Die bestehende Connector-Datei `access.json` enthält ausschließlich `origin`,
`clientId`, `clientSecret`; Origin exakt `https://foundry.heavenforgeprod.com`.
Datei privat unter dem Dienstkonto (0600), niemals im Bundle, Issue oder Argument.
Bei Agentenübergabe `request_secret` verwenden. Keine Cloudflare-Adminrechte für
Main oder Worker. Connector nach Credential-Rotation neu starten: er liest die Datei
beim Start. Redirects und ungültiges TLS bleiben abgewiesen.

## Worker-Versuch vorbereiten

Für den ersten Versuch vorgeschlagene, vom Betreiber noch zu bestätigende Werte:

- Eigenes Konto/Gruppe `foundry-worker`, Home `/var/lib/foundry-worker/home`,
  nicht interaktive Shell; T3-State `/var/lib/foundry-worker/t3` frisch erzeugen.
- Nur `/srv/foundry-worker/workspaces/g2` als Workspace-Wurzel; darin ein neues
  lokales Fixture-Repository ohne Remote und ohne persönliche Daten.
- Loopback-Port `3973`, vor Verwendung auf Belegung prüfen. Keine eingehende
  Freigabe; Connector verwendet `--gateway-origin http://127.0.0.1:3973 --streams`.
- Gemeinsame Slice zunächst `cpuQuotaPercent: 100`, `memoryMaxMiB: 2048`,
  `tasksMax: 256`, nach Prüfung der freien VPS-Ressourcen. Keine Disk-Quota-Zusage.
- Root-eigener sauberer Foundry-Release unter `/opt/foundry-worker/releases/<SHA>`
  und Node gemäß `package.json` unter `/usr` oder `/opt`; `accessFile: true`.
  `providerInstanceId` weglassen. Keine Codex-Installation oder Kontoübernahme.

Installation und Entfernung folgen dem [Worker-Runbook](../../deploy/fork/worker/README.md).
Zuerst nur für das begrenzte Testfenster starten, noch nicht für Boot aktivieren.
Der Installer provisioniert weder Konto noch Runtime. G2-Transportprüfung ist
keine dauerhafte Host-Agentenfreigabe und keine bestandene Dienstkonto-/cgroup-Abnahme.

Für Replay die vorhandene lokale ACP-Replay-Fixture aus
`apps/server/scripts/dev-replay-agent.ts` samt benötigten Runtime-Abhängigkeiten
im Testrelease bereitstellen und ausschließlich im frischen Worker-State als
lokale Provider-Instanz konfigurieren, wie im
[isolierten Prüfer](../../apps/server/scripts/foundry-gateway-integration.ts).
Nicht auf einen persönlichen Checkout verweisen. Der normale
`orchestration.launchThread`-Pfad prüft G2; das ist kein Nachweis des
Codex-gebundenen `foundry.workerLaunch` aus P15.

## Durchführung nach gesonderter Freigabe

1. Wartungsfenster, konkrete Main-/Worker-SHAs, Ressourcen, Backup-Ziel und
   Rücknahmeweg bestätigen. Main-State, Workspaces, `fork_connect` und private
   Konfiguration koordiniert sichern; vorherigen kompatiblen Build behalten.
   Worker-State, Schlüssel, Units und Konfiguration separat sichern.
2. Nach geprüftem Konfigurationsübergang Main starten: Readiness, Schema 5,
   beide bisherigen IDs, Betreiberbindung und Migrator NOLOGIN bestätigen.
   Erwartete Capabilities zusätzlich: `foundry.device-enrollment`,
   `foundry.device-channel`, `foundry.http-gateway`, `foundry.rpc-streams`,
   `foundry.device-catalog`.
3. Worker lokal starten, eigene Environment-ID erfassen und Device-Key unter
   dessen Konto erzeugen. Nur Public Key und Environment-ID an Main geben.
   Über den [Enrollment-Weg](operations.md#experimental-device-enrollment-p06)
   oder den Katalog bestätigen, Einladung binnen zehn Minuten signieren und
   mit Machine-Headers ohne Redirect-Verfolgung posten. Registrierung 0600
   sichern; identischer Retry muss dieselbe Registrierung liefern. Einladung
   und Request danach löschen. Connector starten.
4. Ohne/falsches/abgelaufenes Machine-Credential müssen neue Verbindungen scheitern;
   gültiges Machine-Credential ohne Device-Proof/Stream-Ticket darf keinen Zugriff
   schaffen. Token auf Benutzer-/Gateway-Pfaden muss abgewiesen bleiben.
   Negative Tests nur mit eigenen Testcredentials und ungültigen Fixture-Nachweisen.
5. Zwei getrennte Clientprofile (Web und Windows) melden sich jeweils selbst an
   und koppeln sich mit Main. Keine Cookie-Kopie und kein Worker-Pairing je Client.
   Beide bestätigen die Instanz auf `/foundry`, öffnen Connections, aktualisieren
   den Katalog und wählen dasselbe Device. Offline vor Verbindung, Online danach
   sowie denselben Replay-Thread prüfen; Datei/Diff/Attachment-Hash und Terminal
   über Main in beiden Clients kontrollieren.
6. `clientAccess` im laufenden Terminalstream entziehen: beide Clients verlieren
   Zugriff, neue Grants scheitern; unabhängiger direkter T3-Zugang bleibt gültig.
   Wiederfreigabe verlangt neue Grants. Falsches Environment/Proxy-Ziel abweisen.
   Connector-Unterbrechung, koordinierter Main-Neustart sowie Foundry-/T3- und
   Access-Ablauf getrennt prüfen; keine unbestätigte Terminaleingabe erneut senden.
   Cloudflare kann WebSockets unterbrechen; ein erfolgreicher Upgrade ist kein
   fortlaufender Rechte-Nachweis ([WebSockets](https://developers.cloudflare.com/network/websockets/)).
7. Testregistrierung dauerhaft widerrufen und Enrollment-Replay abweisen.
   Testtoken entziehen, Connector/Worker stoppen, Zugang aus beiden Clients
   erneut prüfen. Stop allein ist kein Widerruf. Ergebnis mit Builds und
   Fehlerkategorien in Issue/PR erfassen, keine Tokens oder privaten Logs anhängen.

Bei Fehler keine weiteren Flags aktivieren. Neue Zugriffe sperren, eigene Worker-
Dienste stoppen und nach dem geprüften Übergangsverfahren zur vorherigen
Konfiguration mit demselben kompatiblen Image zurückkehren. Keine Registrierung
oder SQLite zur Fehlerbehebung löschen. Ein Restore ist eine gesonderte,
koordinierte Operation gemäß [Recovery](access-activation.md#recover-this-upgrade-or-update):
alte Backups können widerrufene Zugänge wiederherstellen; vor Wiederöffnung
Sessions invalidieren und Device-/Machine-Zugänge abgleichen. Persönliches T3,
Kubernetes und PostgreSQL-Nachbardatenbanken bleiben unangetastet.

## Isolierter Vorlauf

```sh
FOUNDRY_TEST_PG_BIN=/path/to/postgresql/bin vp run --filter t3 test:foundry-postgres
python3 -m unittest discover -s deploy/fork/worker -p 'test_*.py' -v
```

Der PostgreSQL-Prüfer erzeugt eigenen Cluster, Main-Zustand und Worker-Kindprozess.
Er prüft echte HTTP-/RPC-Grenzen mit zwei getrennten Sessions und kostenlosem Replay.
Access-JWT/JWKS sind lokale Fixtures, der Connector läuft im Harness. Das ersetzt
weder reale TLS-/Cloudflare-Machine-Authentifizierung und CLI-Prozessintegration
noch Main-Prozessneustart, zwei sichtbare Clients oder systemd-Ressourcendurchsetzung.
