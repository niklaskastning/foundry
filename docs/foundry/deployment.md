# Foundry – Instanzeinstieg, Deployment und Verbindungsmodell

Stand: 31. Oktober 2026 · geprüfter Fork-Stand: `2830704e1`

Status: Finalisierter Zielplan mit technischen Abnahmegates. Ergänzt [Architekturplan](architecture.md), der die Workflow-/Ausführungssemantik besitzt. Neue Pfade, Protokolle und Services in diesem Dokument sind Entwürfe, keine bereits verfügbaren APIs. Der tatsächliche Grundbetrieb steht im [Deployment-Runbook](operations.md).

## 1. Festgelegtes Produkt und aktueller Stand

Ein Foundry-Client verbindet sich durch Eingabe der Hauptdomain mit einer selbst gehosteten Instanz. Nach Anmeldung erhält er Devices, Projekte, Automation und später Sandboxes. Die erste Version ist Single-Tenant/Single-User. Die Main Node besitzt Registry, Anmeldung, Gateway und Automation; ein separates Connect-Produkt oder eine eigene Clerk-Instanz sind keine Voraussetzung.

| Bereits vorhanden                                                                            | Noch umzusetzen                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Fork `niklaskastning/foundry`, eigene Build-Identität und manuelle Updates                   | Instanz-URL als Runtime-Einstieg im Client; zentraler Login und Discovery   |
| Main-Container mit Web und eigener lokaler SQLite-Persistenz                                 | Instanz-Registry, Device-Enrollment und ausgehender Gateway-Transport       |
| PostgreSQL 17 mit vorbereiteten `fork_automation`/`fork_connect`-Datenbanken                 | Anwendungsschemas, Runtime-/Migrationsrollen und DB-Anbindung der Main Node |
| `foundry.heavenforgeprod.com` über betreiberverwalteten Tunnel und Access → `127.0.0.1:3783` | Getestete Desktop-Anmeldung sowie Machine-Auth für Device-Verbindungen      |
| Browser-Pairing zum Main-Environment                                                         | Eigenständiger Host-Worker; Provider-Verfügbarkeit und Anmeldung dort       |
| Linux-/Windows-Build-Einstieg, ein automatischer PR-Check                                    | Windows-Laufzeitabnahme, Automation und Sandbox-Provisionierung             |

Das Main-Environment hat derzeit keine Codex-CLI. Sie wird für seine künftige Steuerungsrolle nicht benötigt. Echte Agenten starten auf einem registrierten Ausführungs-Device. Bestehendes persönliches T3 und dessen `~/.t3/userdata` werden weder migriert noch als Foundry-Worker vereinnahmt.

Der frühere Plan „eigener Cloudflare Worker + Clerk + Hyperdrive + Tunnel pro Environment“ entfällt. Keine Provisionierung dieser Ressourcen für den neuen Einstieg. Upstreams `infra/relay` bleibt für Integrationsmerges erhalten, wird aber nicht als Foundry-Dienst deployed.

## 2. Bewertung der vorhandenen T3-Bausteine

| Vorhandene Grundlage                                                                                                                                                     | Wiederverwendung und Grenze                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Connect](../internals/t3-connect.md), [Discovery](../../packages/client-runtime/src/relay/discovery.ts)                                                                 | Identitäts-/Bootstrap-Prinzipien und Client-Zustandsmodell nutzen. Heute Clerk-gebundener Broker mit direkten Environment-Endpunkten, kein zentraler Datenproxy                   |
| [Connection Runtime](../internals/connection-runtime.md)                                                                                                                 | Bestehenden Supervisor und Fehlerzustände erweitern; keinen unabhängigen Reconnect-Loop pro UI-Funktion bauen                                                                     |
| [EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts), [DPoP](../../apps/server/src/auth/dpop.ts), [SessionStore](../../apps/server/src/auth/SessionStore.ts) | Schlüsselbindung, Session-Scopes, Socket-Tickets und Widerruf erhalten. DPoP bindet die konkrete Request-URL; ein transparentes Path-Rewrite ist keine fertige Gateway-Lösung     |
| [PeerLinks](../../apps/server/src/peer/PeerLinks.ts), [RemoteDelegation](../../apps/server/src/peer/RemoteDelegation.ts)                                                 | Remote-Identität und Weiterleitung als Grundlage. Delegation hängt heute an einem Eltern-Thread; Automation braucht servicebasiertes Launch/Follow/Cancel ohne Agenten-Elternteil |
| [ThreadLaunchService](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts), [EffectWorker](../../apps/server/src/orchestration-v2/EffectWorker.ts)             | Threads und Checkpoints aus vorhandenen Services. Worker-Receipts und fachlicher Step-Abschluss sind zusätzliche Verträge                                                         |
| [Relay-Datenbank](../../infra/relay/src/db.ts)                                                                                                                           | PostgreSQL-/Effect-Erfahrung vorhanden; Alchemy, PlanetScale, Hyperdrive und Worker-Bindungen werden nicht in die Main-Runtime importiert                                         |
| [Desktop](../internals/remote.md#desktop-without-a-local-environment)                                                                                                    | Windows kann ohne lokales Environment arbeiten; der gebündelte Client braucht trotzdem eigene Instanz-/Auth-/Transport-Anpassungen                                                |
| [Managed Codex](../../apps/server/src/provider/CodexManagedRuntime.ts)                                                                                                   | Lokale Provider-Anmeldung und Token-Broker sind Grundlage, keine fertige hostübergreifende Sandbox-Credential-Verteilung                                                          |

**Machbarkeit:** Der Aufbau ist mit dem bestehenden Thread-/Provider-Modell vereinbar. Die größten neuen Teile sind Instanzauthentifizierung, das zentrale Gateway und die zuverlässige Automation-Dispatch-Grenze. Unveränderte offizielle Clients oder Server werden nicht automatisch Instanzteilnehmer. Kompatibilität wird über explizite Foundry-Protokollversionen und Capabilities ausgehandelt.

## 3. Eine Domain, mehrere Authentifizierungsarten

### 3.1 Instanzidentität und Client-Start

Vorgeschlagen ist ein kleiner Metadaten-Endpunkt `/.well-known/foundry` mit Protokollversion, `instanceId`, Main-`environmentId`, öffentlicher Basis-URL und Auth-Verfahren. Er enthält keine Device-Liste oder Secrets. Hinter Access muss der Client zuerst eine Anmeldeumleitung erkennen können, statt HTML als JSON zu parsen. Nur HTTPS wird für entfernte Instanzen akzeptiert; private Entwicklungsinstanzen erfordern eine ausdrückliche lokale Konfiguration.

Der Client speichert die bestätigte Instanzidentität und bindet Accounts, Sessions, Geräte-Caches und Schlüssel daran. Ein unerwarteter Wechsel von Instanz-ID/Issuer ist keine automatische Neuanmeldung. Metadaten dürfen Tokens nicht auf beliebige Fremd-Origins umlenken; Auth-Ziele werden durch den bestätigten Betreiber-Auth-Vertrag begrenzt. Zunächst eine aktive Instanz pro Client, mit sauberem Wechsel/Logout; parallele Instanzen folgen bei Bedarf.

### 3.2 Benutzer: Cloudflare Access zuerst

Web nutzt den bestehenden interaktiven Access-Login. Main validiert den signierten Access-Nachweis gegen konfigurierten Issuer, Audience und Ablauf und ordnet den bestätigten Subject genau dem vorkonfigurierten Betreiber zu. Keine ungeprüften E-Mail-/Forwarding-Header und kein öffentliches „erster Besucher wird Admin“. Danach gilt eine eigene widerrufbare Foundry-Session; der Access-Nachweis wird nicht zum universellen Device-Token. [Cloudflare: JWT-Prüfung](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

Für Windows ist der erste zu prüfende Weg ein dediziertes Electron-Anmeldefenster mit isolierter, instanzgebundener Session-Partition. HTTP und WebSocket des Instanztransports müssen denselben autorisierten Access-Kontext nutzen. Remote-Login-Inhalte erhalten weder Node-Zugriff noch allgemeines Electron-IPC; Callback und erlaubte Navigation werden begrenzt. Ein Systembrowser-Cookie steht dem gepackten Desktop-Renderer nicht automatisch zur Verfügung. Fremde Device-Antworten dürfen keine Access-Cookies oder privilegierten Renderer-Inhalte setzen.

**Früher Auth-Nachweis (G1 im Umsetzungsplan):** Reale Anmeldung mit dem verwendeten IdP, API-Aufruf, WebSocket, Ablauf/Erneuerung, Logout und Neustart in einem Windows-Build. Einige IdPs erlauben eingebettete Anmeldung nicht. Dann wird vor weiterer Implementierung ein Systembrowser-/PKCE-Weg mit Cloudflare Managed OAuth geprüft, einschließlich Verfügbarkeit im Account und Auth-Header-Konflikten. Keine pauschale Deaktivierung von Access und kein gemeinsamer Service-Token im Desktop-Bundle als Ersatz. [Cloudflare: Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

Die konkrete Login-Transportvariante ist eine begrenzte technische Gate-Entscheidung, kein offenes Produktmodell. Ohne bestandenen Native-Login ist der Desktop-Einstieg nicht abgenommen. Späteres Clerk/OIDC ersetzt den Identitätsadapter; es migriert die externe Subject-Bindung zur bestehenden internen Benutzer-ID und erfindet nicht nebenbei Teams/Rollen.

### 3.3 Devices: unbeaufsichtigte Verbindung

Ein Betreiber erzeugt eine kurzlebige, einmalige Enrollment-Freigabe für ein Device. Das Device erzeugt einen eigenen Schlüssel und bindet den Enrollment-Nachweis an diesen Schlüssel sowie Instanz-/Environment-Identität. Registrierung, Ausgabe einer Geräteberechtigung und Verbrauch des Einmalnachweises sind wiederholbar und transaktional. Ein gestohlener Anzeigename oder wiederverwendetes Bootstrap-Token reicht nicht zur Übernahme.

Für den Access-geschützten Machine-Eingang verwendet das Device zusätzlich einen getrennten, auf diesen Pfad begrenzten Access-Service-Zugang. Diese äußere Berechtigung wird über geschützte Provisionierung übergeben; sie ersetzt weder den Device-Schlüssel noch Grants. Initial manuelle operatorseitige Einrichtung ist akzeptabel; die Main Node benötigt dafür keine Cloudflare-Account-Adminrechte. Nach Enrollment wird der Einmalnachweis gelöscht. [Cloudflare: Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

Device-Zugang, interaktiver Benutzerzugang, Automation-Ausführung und Sandbox-Provisionierung haben getrennte Grants. In der ersten Version verwaltet ein Benutzer alle vier, ohne Gruppenmodell. Vollständiges Trennen widerruft alle zugehörigen Foundry-Zugänge; Cloudflare-Service-Zugänge müssen ebenfalls rotiert/entzogen werden. Keys und Grants können rotiert werden, ohne die Environment-ID zu ändern.

### 3.4 GitHub und andere externe Trigger

Normale UI-/API-Pfade behalten Access-Schutz. Für einen GitHub-Webhook ist später eine eng abgegrenzte Route wie `/hooks/github/<binding>` vorgesehen, die ohne interaktiven Access-Login erreichbar ist und ausschließlich signierte Connector-Ereignisse annimmt. Main prüft unveränderte Body-Bytes, HMAC, zugelassene Installation/Repository/Event-Typ, Größenlimit und Deduplizierung vor Verarbeitung. Erfolg erst nach Inbox-Commit. Keine solche Ausnahme für `/api`, Gateway oder Enrollment. [GitHub: Webhook-Signaturprüfung](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

**Default zunächst: manuell und GitHub-Polling**, solange der Betreiber diese differenzierte Access-Regel nicht eingerichtet hat. Polling benötigt keinen öffentlichen Eingang, aber API-Zugriff, persistente Cursor, Backoff, Rate-Limit-Budget und fachliche Deduplizierung mit Webhooks. Es erkennt zustandsbasierte Änderungen, garantiert nicht die Rekonstruktion jeder zwischen zwei Abrufen verschwundenen Ereignisfolge. Eine vollständig interaktiv geschützte Domain und direkte beliebige SaaS-Webhooks sind keine gleichzeitig erfüllbare Vorgabe.

## 4. Gateway und Vertrauensgrenzen

### 4.1 Verbindungsweg

Der Client spricht nur mit der Hauptdomain. Main routet zu registrierten Environment-IDs. Jedes Device hält einen ausgehenden authentifizierten TLS/WebSocket-Kanal zur Main Node; es benötigt weder eingehenden öffentlichen Port noch einen eigenen Cloudflare-Tunnel. Der Connector spricht nur sein lokales registriertes Environment, keine vom Client angegebene URL. Enrollment-Rechte erlauben kein allgemeines Forwarding ins LAN oder zur Cloud-Metadatenadresse.

Main vermittelt begrenzte HTTP-Anfragen und gestreamte Antworten sowie langlebige WebSocket-/Terminalkanäle. Der Connector authentifiziert sich unabhängig vom einzelnen Stream; jeder Stream bindet Device, Environment, Akteur, Grant und Generation. `deviceId` und `environmentId` sind verschieden: ein Sandbox-Host kann mehrere kurzlebige Environments verwalten.

### 4.2 Gewähltes Auth-Modell: vertrauenswürdiges Gateway

Die Main Node terminiert die Client-Instanzauthentifizierung und prüft pro Route/Operation den Grant. Für das Ziel-Environment nutzt sie eine davon getrennte, begrenzte Environment-Session. Client-DPoP wird gegen die tatsächlich angefragte öffentliche URL geprüft; es wird nicht unverändert nach einem Pfad-/Host-Rewrite weitergereicht. Device-seitige Requests erhalten einen eigenen korrekten Nachweis. Das Gateway ist damit ein vertrauenswürdiger Sicherheitsbaustein und kann Daten lesen; Ende-zu-Ende-Verschlüsselung gegenüber Main wird nicht behauptet.

Die ausgehende Session darf höchstens die Schnittmenge von Benutzer-/Automation-Grant und Device-Freigabe besitzen. Kein generisches Admin-Token für alle Clients. Ein versionierter Auth-Adapter erhält Akteur, Scopes und Herkunft für Device-seitige Autorisierung/Audit, ohne beliebigen Client-Headern zu vertrauen. Bestehende T3-Scope- und Session-Prüfungen werden nicht deaktiviert. Ob vorhandene Sessions bereits die benötigte Delegationsbindung abbilden, wird in G2 geprüft und nötigenfalls additiv erweitert.

Device-Cookies, interne Redirects und beliebige URLs werden nicht blind an den Browser weitergereicht. Keine Device-HTML-Seite mit aktiven Inhalten unter der privilegierten Instanz-Origin; die lokale Foundry-UI rendert typisierte Daten, Downloads sind sicher ausgeliefert. Projekt-Previews benötigen später eine eigene isolierte Origin oder gleichwertige nachgewiesene Isolation. Same-Origin-Pfadpräfixe allein isolieren keine Cookies, Skripte oder Service Worker.

### 4.3 Rückstau, Reconnect und Widerruf

- Kontrollnachrichten haben eine eigene begrenzte Queue gegenüber großen Datenströmen. Pro Device/Client gelten Stream-, Byte- und Parallelitätslimits; langsame Empfänger erzeugen Backpressure oder einen sichtbaren Abbruch statt unbeschränkten Speicherverbrauch.
- Ereignis-/Dateitransfers verwenden Cursor, Sequenznummern und bestätigte Chunks. Mutationen werden nur mit stabilen Command-IDs wiederholt. Unbestätigte Terminaleingaben werden nicht automatisch erneut gesendet; unterbrochene Terminals sind als solche sichtbar.
- Main-Neustart schließt Verbindungen. Connector und Client verbinden mit Backoff erneut, bestätigen Identität/Generation und laden fehlende dauerhafte Daten. Ein offener Socket ist keine Queue oder Zustellgarantie.
- Neue Streams und neue Mutationen prüfen aktuelle Grants; Widerruf schließt betroffene aktive Streams und Environment-Sessions. Lange Verbindungen haben begrenzte Auth-Gültigkeit und benötigen Erneuerung. Eine Edge-Prüfung beim Handshake allein setzt spätere Rechteänderungen nicht durch.
- Ein Gateway-Ausfall trennt den gesamten Instanzzugriff. Laufende Device-Prozesse können weiterlaufen; bei Automation greift die lokale Lease-/Stop-Regel. Nach Reconnect werden Receipts abgeglichen, nicht Aufträge blind neu gestartet.
- Logout eines Clients, Widerruf eines Device und Stop eines Agenten sind getrennte Aktionen. Der Widerruf einer Verbindung garantiert keinen sofortigen Stop eines offline laufenden Prozesses oder externer API-Tokens.

Cloudflare unterstützt WebSockets, kann Verbindungen aber bei Infrastrukturänderungen beenden; WAF-Prüfung erfolgt am Upgrade und nicht fortlaufend auf Nachrichten. Reconnect und App-seitige Grenzen bleiben Pflicht. API/Auth-/Gateway-Pfade werden nicht gecacht. [Cloudflare: WebSockets](https://developers.cloudflare.com/network/websockets/)

Direkte LAN-/Tailscale-Verbindungen bleiben als unabhängiger T3-Modus bestehen. Für instanzverwaltete Sessions gibt es zunächst keinen automatischen Direktpfad, der zentrale Freigaben umgeht. Ein späterer Direktmodus braucht kurzlebige endpointgebundene Sessions und eigenen Widerrufsvertrag.

## 5. Deployment und Persistenz

### 5.1 Prozesse auf der ersten VPS

| Prozess                              | Rolle und Grenze                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Foundry Main im Container            | Web, Instanz, Gateway und Automation; ein aktiver Prozess, keine Agenten-Builds oder Provider-CLI für Steuerung |
| PostgreSQL im Container              | Zentrale Instanz- und Automation-Daten, keine öffentliche Portfreigabe                                          |
| Vorhandenes hostseitiges cloudflared | Hauptdomain → `127.0.0.1:3783`; Tunnel/DNS/Access bleiben operatorverwaltet                                     |
| Foundry Host-Worker als Dienst       | Eigenes Home, Projekte, Provider-CLI und Anmeldung; anfangs ein aktiver Agent, keine Sandbox-Garantie           |
| Später Sandbox-Supervisor            | Explizit berechtigter lokaler Dienst auf einem Sandbox-Provider; allein er erhält Infrastrukturrechte           |

Das Host-Betriebskonto und erlaubte Workspace-Wurzeln werden vor Einrichtung festgelegt. Ein separater Linux-Benutzer begrenzt Zugriffe besser; Nutzung des bestehenden Benutzers vereinfacht Werkzeuge, übernimmt aber dessen Dateirechte. Kein stilles Kopieren persönlicher Provider-Secrets. Main, PostgreSQL und Host-Agenten benötigen getrennte Ressourcenbudgets, damit ein Build nicht Datenbank und Gateway verdrängt.

Das Main-Image enthält Server und Web desselben Builds. Windows enthält dieselbe React-Oberfläche, mit eigenem Branding, Datenpfad und deaktiviertem offiziellem Updater. Instanz-URL wird zur Laufzeit eingegeben; Cloudflare- oder Provider-Secrets gehören nie ins Bundle. Im ersten Deploy bleiben die vorhandenen Connect-Build-Flags deaktiviert; sie implementieren den neuen Instanzmodus nicht.

### 5.2 Datenverantwortung und Migration

| Bestand                                                                                                       | Speicher / Owner                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Instanzidentität, Benutzerbindung, Device-Registry, Grants, Zugangsgenerationen                               | `fork_connect`, neuer Instanz-Service der Main Node; Name bleibt aus bestehendem Grunddeployment erhalten |
| Definitionen, Trigger-Inbox, Runs, Attempts, Dispatch-Outbox, Sandbox-Allocations, Artefakt-/Memory-Metadaten | `fork_automation`, Automation-/Provisionierungsservice                                                    |
| Lokale Projekte, Threads, Provider-Sessions                                                                   | Bestehende lokale SQLite-Persistenz des jeweiligen Environments                                           |
| Archive, Git-Objekte, große Anhänge                                                                           | Persistentes Artefaktverzeichnis, später Object Storage; keine großen Blobs in Queue-Zeilen               |
| Private Schlüssel und Provider-/Connector-Zugänge                                                             | Geschützter Secret-Speicher, verschlüsselte Sicherung mit getrenntem Schlüsselmaterial                    |

`fork_connect` erhält neue Foundry-Migrationen, nicht unverändert Upstreams Relay-Migrationen. Vor Migration muss nachgewiesen sein, ob die vorbereitete DB wirklich leer ist; unbekannte Daten blockieren statt gelöscht zu werden. Beide DBs haben eigene Runtime-/Migrationsrollen und Versionsprüfungen. Die bestehenden NOLOGIN-Owner und leeren DBs allein sind noch keine Anwendungseinrichtung. Upstreams SQLite-Migrationsnummern bleiben unangetastet.

Automation und Instanz-Service sprechen über begrenzte interne APIs. Es gibt keine globale Transaktion zwischen beiden Datenbanken: Ein gespeicherter Run-Grantsnapshot ist keine dauerhafte Zugriffserlaubnis. Grant und Zugangsgeneration werden vor Dispatch, Credential-Ausgabe und Publishing aktuell geprüft; Widerruf invalidiert auch aktive Sessions. Laufende entfernte Prozesse brauchen zusätzlich Fencing/Stop gemäß Architekturplan.

Queue-Claims nutzen kurze Transaktionen, persistente Leases und `FOR UPDATE SKIP LOCKED`; Netzwerk/Agenten laufen außerhalb der Transaktion. Unique Constraints sichern Command-/Dispatch-/Delivery-IDs. `LISTEN/NOTIFY` weckt nur auf; nach Neustart wird die dauerhafte Queue gescannt. Eigene Effect-Pg-Layer, keine neue ORM-Plattform. [PostgreSQL: SELECT](https://www.postgresql.org/docs/17/sql-select.html), [NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)

DB-Pools teilen ein gemessenes Budget mit Backups/Migration/Administration. Keine DB-Verbindungen für Devices und kein Hyperdrive-/Cloudflare-VPC-Zugang. Migrationen laufen einmal mit Sperre und eigener Rolle; danach prüft Runtime kompatible Schemas. DB-Ausfall sperrt neue Sessions, Grants und Auftragsannahme; keine lokale Ersatzdatenbank und kein erfolgreicher Webhook ohne Commit. Bereits aktive Zugriffe dürfen nicht unbefristet mit veraltetem Grant fortlaufen.

### 5.3 Portabilität und Verfügbarkeit

Das Main-Image soll ohne eingebettete Hostpfade oder Cloudflare-Verwaltungsabhängigkeit auch auf einem anderen Container-Host laufen. Dafür bleiben öffentliche Basis-URL, Datenbank, persistenter Speicher, Secrets und Ingress konfigurierbar. Ein Umzug in eine Azure-Containerplattform ist dennoch eine eigene Betriebsabnahme: WebSocket-/Idle-Limits, ausgehende Verbindungen, Secret-Zugriff, Shutdown-Frist, CPU/RAM und persistente Volumes müssen passen. Keine Zusage für ein unbenanntes Azure-Produkt.

Zunächst genau eine aktive Main-Replik und kein Scale-to-zero. T3-SQLite darf nicht gleichzeitig von mehreren Main-Containern auf einem gemeinsam gemounteten Dateisystem betrieben werden. Rollouts verwenden kontrolliertes Stop/Start; Gateway-Reconnect gehört dazu. Spätere horizontale Skalierung benötigt getrennte Zuständigkeit für Sessions/Socket-Routing, Lease-Owner und Artefakte sowie geeignete T3-Persistenzgrenzen. PostgreSQL allein macht die Anwendung nicht hochverfügbar.

## 6. Umsetzungsreihenfolge und Abnahmegates

Der [Umsetzungsplan](implementation-plan.md) besitzt die PR-großen Arbeitspakete und alle Gate-Definitionen. G1 prüft den Instanzeinstieg, G2 Gateway und Zugriffsentzug, G3 den dauerhaften Worker, G4 den ersten Workflow und G5 den Wiederherstellungsbetrieb. Die spätere Sandbox-Abnahme G8 umfasst sowohl interaktive als auch Workflow-Nutzung. Die Reihenfolge und Abhängigkeiten werden dort gepflegt, nicht parallel in diesem Dokument.

## 7. Integrationsstellen und Kompatibilitätsvertrag

Geplante neue Bereiche sind `apps/server/src/instance/`, `packages/contracts/src/instance/` und `packages/client-runtime/src/instance/`. Sie besitzen Instanzauth, Registry, Gateway und Client-State; die Workflow-Domäne bleibt in `automation/` mit ihrem T3-Adapter. Provisionierung ist auch ohne Workflow erreichbar und darf nicht nur an einen Run-Handler gebunden sein. Upstream-nahe Änderungen an Serverkomposition, Auth und Transport bleiben kleine benannte Integrationspatches.

Client, Main, Worker und Sandbox-Image melden Protokollversion und Fähigkeiten. Zu Beginn werden Builds derselben freigegebenen Version unterstützt; ein älterer Teilnehmer bekommt eine klare Inkompatibilitätsmeldung statt teilweiser stiller Funktion. Spätere Versionstoleranz wird nur für getestete Bereiche zugesagt. Keine gleichnamigen neuen RPCs ohne Fork-Namespace, keine Migration in T3s Nummernfolge.

Ein Upstream-Update prüft insbesondere Auth-URL-Bindung, Socket-Tickets, Connection-Supervisor, Launch/Stop, Checkpoints, Provider-Auth und Projekt-Setup. Fork-Profil und deaktivierte offiziellen Update-/Telemetry-Wege bleiben bestehen. Wiederverwendung von Relay-Code erfolgt nur über tatsächlich portable Verträge/Services; kein zweites kopiertes `infra/relay` mit eigener divergierender Runtime.

## 8. Betrieb, Recovery und spätere Stolperstellen

- **Readiness:** Für Instanzbetrieb müssen die benötigten DB-Schemas und Services bereit sein. Der heutige reine HTTP-Healthcheck bestätigt nur Grundbetrieb. Provider-Ausfall ist ein Device-/Capability-Fehler, kein pauschaler Main-Ausfall.
- **Backups:** PostgreSQL, Main-/Worker-State soweit nötig, Artefakte und Schlüssel koordiniert sichern. Externes Ziel, RPO/RTO und Aufbewahrung vor Dauerbetrieb festlegen. Restore isoliert testen; ein Docker-Volume auf der VPS ist kein Backup.
- **Restore:** Trigger, Enrollment und Publishing zunächst sperren. Device-Receipts, externe PRs, Sandbox-Besitz und Archiv-Cursor abgleichen. Zugangsgenerationen/Schlüssel rotieren, damit ein altes Backup widerrufene Credentials nicht reaktiviert. Keine blinde Löschung von Devices oder Cloudressourcen anhand veralteter Daten.
- **Upgrade:** Vor Migration neue Aufträge stoppen, laufende Arbeit drainen oder kontrolliert unterbrechen. Gesperrte Migration → Main-Rollout → Readiness → Wiederaufnahme. Image-Rollback nur mit kompatiblem Schema, sonst koordinierter Restore. Artefakte mit Fork-SHA, Upstream-SHA und Schema-/Protokollversionen kennzeichnen.
- **Kontingente:** Gateway-Streams, Sandbox-Zahl, Disk/Artefaktvolumen und kontoweite Provider-Parallelität begrenzen. Ein Instanzbenutzer bedeutet nicht unbegrenzte Provider-Nutzung. Kein automatischer Wechsel von Subscription zu API-Abrechnung.
- **Audit:** Akteur, Device, Scope, Allocation/Attempt und Grant-Generation für kritische Aktionen nachvollziehbar speichern. Keine Auth-Header, Refresh-Tokens, Pairing-Links oder vollständigen sensiblen Payloads in allgemeinen Logs.
- **Beobachtbarkeit:** Gateway-Reconnects, Queue-Alter, unklare Attempts, DB-/Disk-Auslastung, Backup-Alter, Provider-Auth-Fehler und Archiv-Rückstand erfassen. Limits anhand der ersten Laufzeittests festlegen; keine erfundenen Durchsatz-/Kostenversprechen.
- **Enterprise später:** Single-Tenant ist eine Deployment-Grenze, keine Mehrmandanten-Isolationszusage. Teams erfordern objektbezogene Rechte auf Devices, Projekte, Archive, Secrets und Sandbox-Profile, nicht nur gefilterte UI-Listen. Clerk allein implementiert diese Rechte nicht.

Noch operatorseitig vor den jeweiligen Gates festzulegen: Dienstbenutzer/Workspace-Wurzeln, Access-Machine-Policy und mögliche Webhook-Ausnahme, erster Provider-Zugang und GitHub-Repository/Label, Backup-Ziel sowie Ressourcen-/Aufbewahrungsgrenzen. Diese Punkte blockieren die Finalisierung des Plans nicht; sie werden vor Aktivierung der abhängigen Funktion konkret entschieden.
