# Foundry – Umsetzungsplan in PR-großen Arbeitspaketen

Stand: 3. November 2026. Planungsbaseline für [Architektur](architecture.md) und [Deployment](deployment.md). Die Pakete P01–P60 sind **keine GitHub-PR-Nummern**. Auf Maintainerwunsch führt dieser Plan nach Abschluss von [Issue #13](https://github.com/niklaskastning/foundry/issues/13) auch die erledigte Implementierung und offenen Abnahmen. Detaillierte Evidence bleibt in den verlinkten Issues/PRs; erledigter Code ist keine pauschale Gate- oder Deployment-Abnahme.

## Erledigte Implementierung und verbleibende Abnahmen

Die Häkchen bezeichnen den jeweils genannten Umfang. Offene Teilnachweise werden nicht durch einen Merge oder diese Statusübernahme geschlossen.

- [x] **P01–P03 (Access-Modus):** Identität, Instanz-PostgreSQL und Access-Sessions implementiert und integriert; Integrationsstack [#29](https://github.com/niklaskastning/foundry/pull/29), erweiterte isolierte Nachweise [#30](https://github.com/niklaskastning/foundry/pull/30).
- [x] **P04/P05 – Implementierung:** Windows-Access-Transport und Instanzeinstieg integriert. Diagnose und JSON-Decoder für gekoppelte T3-Sessions in [#42](https://github.com/niklaskastning/foundry/pull/42)/[#43](https://github.com/niklaskastning/foundry/pull/43) korrigiert; P05-Instanzwechsel bleibt ein eigener Live-Nachweis.
- [x] **Windows-Session-Lebenszyklus:** Login, Check, Refresh vor Ablauf, vollständiger App-Neustart und Wiederanmeldung nach mindestens 16 Minuten ohne erneutes T3-Pairing bestätigt. [Evidence](https://github.com/niklaskastning/foundry/issues/13#issuecomment-6588567831); Build `41519672835`, Source `b57fbec08`. Die genaue Trennung von Foundry- und Access-Ablauf ist damit nicht belegt.
- [x] **P06–P12 – Implementierung und realer G2-Durchstich:** Enrollment, Maschinenkanal, Gateway, Streams, Grants und Katalog integriert; dedizierter Linux-Worker über Main aus Windows/Electron und Firefox nutzbar. Replay, Terminal, Datei/Diff und Entzug/Wiederfreigabe bestätigt. Attachment-Vorschau in beiden Clients und Firefox-Download nach [#41](https://github.com/niklaskastning/foundry/pull/41) bestätigt. Windows-Download bleibt ausgenommen.
- [x] **P13–P17 – Code und Integration:** isolierter Host-Dienst, Readiness/Binding, idempotenter Launch, Read/Follow/Cancel, Lease/Manifest und Workspace-/Writer-Integration über den Basisstack [#29](https://github.com/niklaskastning/foundry/pull/29), den P16-Abschluss [#38](https://github.com/niklaskastning/foundry/pull/38) und die Integration [#39](https://github.com/niklaskastning/foundry/pull/39)/[#40](https://github.com/niklaskastning/foundry/pull/40) integriert. Der funktionale G3-Workerabschluss ist inzwischen real bestätigt; verbleibende G1/G2- und Betriebsabnahmen bleiben getrennt offen.
- [x] **P18a – isolierte Grundlage:** Factory/Version/WorkItem mit eigener Automation-PostgreSQL-Persistenz in [#36](https://github.com/niklaskastning/foundry/pull/36) implementiert und getestet. Noch inaktiv; keine Scheduler-/Startfreigabe.
- [x] **P18b – Implementierung und isolierter PostgreSQL-Nachweis:** unveränderliche sequenzielle Workflow-Versionen, gepinnte Runs und atomare Command-/Run-/Outbox-Persistenz in [#46](https://github.com/niklaskastning/foundry/pull/46) implementiert und in Main integriert. Schema-1-Upgrade mit bestehenden P18a-Daten, parallele Retries, Scope-/Referenzfehler, Versions-/Revisionshistorie, Archivierung, echter DB-Neustart und injizierter Rollback nach Run-Insert geprüft. Weiterhin inaktiv; kein Dispatch oder Zugriff auf reale Automation-Datenbanken.
- [x] **P47 – Implementierung und isolierter Nachweis:** kanonische `factory.yaml` mit Workflow-Dateien, gemeinsamer Validator, semantischer Hash/Herkunft und atomare Aktivierung mit erwartetem Basisstand in [#47](https://github.com/niklaskastning/foundry/pull/47) implementiert und in Main integriert. 21 Validator-Tests und echter temporärer PostgreSQL-Nachweis für Roundtrip, Scope-/Dateifehler, Konflikte, Rollback, Schema-1/2-Upgrade, DB-Neustart und gepinnte Runs. Kein Startup-/UI-/Dispatch- oder Git-Anschluss aktiviert.
- [ ] **G1-Restabnahme:** P05-Instanzselektor, frisches Profil, Instanzwechsel/Entfernen und zwei reale getrennte Instanzen; genaue Access-/Foundry-Ablauftrennung. Die bestandenen Windows-Session-Folgen nicht ohne Änderung oder Fehler wiederholen.
- [ ] **G2-Restabnahme:** Worker auf getrennter zweiter Maschine und gezielter Main-/Connector-Abbruch mit Wiederverbindung beider Clients; Wiederaufnahme eines laufenden Auftrags separat von bloßer Erreichbarkeit nach Neustart belegen. Permanente Device-Widerrufsprobe nur mit geplantem Wiederanmeldungsweg. Bereits bestätigte Terminal-/Replay-/Grant-Proben übernehmen.
- [x] **G3 – reale Teilnachweise am 3. November:** `codexG3`/CLI `0.156.1` über Headless-ChatGPT-Anmeldung gebunden und frisch bereit. Drei begrenzte Luna-Turns im eigenen Git-Fixture: expliziter Cancel mit positivem Writer-Ende/`stopped`-Manifest; erfolgreicher `foundry.workerLaunch` mit verworfener RPC-Antwort, identischen Retries, Read/Follow ab Cursor, erneuerter Lease und unverändertem generationgebundenem `completed`-Manifest; Launch-Verbindungsabbruch ohne weitere Erneuerung mit lokalem Watchdog-Stop. Konkurrierender manueller Einstieg scheitert vor nativem Provider-Turn. Details und Grenzen in [#45](https://github.com/niklaskastning/foundry/pull/45).
- [x] **G3 – unabhängiger Ergebnis- und Idle-Restart-Nachweis:** Betreiberlauf am 3. November bestätigt unter Dienstkonto genau einen Thread/Run/Attempt, positives Writer-Ende, dasselbe Generation-2-Manifest, passenden `ready`-Checkpoint, vorhandenes Git-Objekt und exakten Dateiinhalt. Zuvor kontrollierter Neustart des untätigen Workers mit leeren alten Dienst-cgroups; nachher `providerReady=true`, CLI `0.156.1`, `activeRuns=0`, unveränderte Environment-ID und `foundryManagedWorkspaces=true`. Prüfersession widerrufen.
- [x] **G3 – aktiver Crash und gehaltene Sperre:** echter nativer Pending-Command vor dem gezielten Worker-/Connector-Crash, leere alte Dienst-cgroups und erfolgreicher Neustart bestätigt. Vor der Recovery blieb Generation 4 `uncertain`, `writerEnded=false`, ohne Manifest und mit gehaltener Reservation; identische Anfrage liefert unverändertes Receipt und genau einen Run/Attempt/nativen Turn, ohne neuen Provider-Start.
- [x] **G3 – funktionaler Workerabschluss einschließlich Recovery:** Generation 4 über den bestehenden Service-Pfad real als `stopped` mit `writerEnded=true`, generationsgebundenem Stop-Manifest und freigegebener Workspace-Reservation bestätigt. Unverändert genau ein Run/Attempt/nativer Turn, gleiches Receipt, null Ersatzstarts. Worker-Release `6643d6439`, private Konfigurations-/SQLite-Recovery `/var/lib/foundry-deploy/worker-g3-recovery-8r5u81yp`; Main unverändert. Zusammen mit den obigen realen und fokussierten deterministischen Nachweisen ist G3 für die folgende inaktive Factory-Entwicklung bestanden. Der einzelne Betreiberprüfer bleibt bewusst kein aggregierter Gate-Entscheider (`g3FullyAccepted=false`). Main-/Connector-Reconnect beider Clients bleibt G2; volle Ressourcen-/Restore-Lastabnahme bleibt Betriebsarbeit.
- [ ] **Betriebsnachweise:** aktive Kernel-Limits (1 CPU, 2 GiB, 256 Tasks) sind geprüft; Last-/Kindprozess-Durchsetzung und vollständiger Restore sind offen; die begrenzte aktive Worker-Recovery ist in G3 bestätigt. Vor breiter automatisierter Last die für G3 nötigen Grenzen prüfen; vollständiger Backup-/Restore-/Upgrade-Nachweis gehört zu G5. Dauerhafte Entscheidung zum für das Testfenster deaktivierten zonenweiten Cloudflare Bot Fight Mode offen, keine eigenständige Policy-Änderung.
- [ ] **Produktlücken:** P03N/G1-Nativ, automatischer Katalog-Erstabruf und Einstieg ohne getrenntes T3-Pairing noch nicht umgesetzt. Windows-Downloads im Foundry-Einstieg sind durch dessen `will-download`-Sperre blockiert und bleiben gesonderte begrenzte Produktarbeit, kein behaupteter Upstream-Fehler. Native Mobile-Abnahme bleibt verschoben.
- [ ] **Zentrale Verbindungen und Autorisierungsweitergabe:** noch nicht implementiert. Provider-, Source-Control- und später MCP-Zugänge einmal in Foundry einrichten; dauerhafte Devices und Sandboxes erhalten daraus ausdrücklich autorisierte Laufzeitbindungen. P14Z ergänzt die zentrale Grundlage; P23/P41/P37/P52 integrieren die jeweiligen Zugangsarten. Die lokale Anmeldung für G3 ist ein Übergangsweg, kein erfüllter zentraler Login.
- [ ] **Separates Definitions-Repository:** auf Maintainerwunsch verbindliche Quelle für Factory-Definitionen, Workflows und künftig Agenten/Skills; getrennt von Appcode und Arbeits-Repositories. Das private Repository [niklaskastning/foundry-definitions](https://github.com/niklaskastning/foundry-definitions) ist angelegt und lesend bestätigt (`main`, zunächst README). Foundry-App-Zugang und Git-Verwaltung folgen konkret über P23/P48; vorhandener Entwicklerzugriff ist keine App-Bindung. Bis dahin manueller P47-Import/Export als Übergang, keine behauptete automatische Git-Synchronisation. Credentials/Grants bleiben außerhalb der Definitionen; PostgreSQL speichert aktivierte Snapshots und Historie.
- [x] **P38a – Implementierung und funktionale Abnahme:** dauerhafte Instanz-Metadaten/Blobs, bestätigtes Chunk-Resume, idempotente Veröffentlichung, getrennte Benutzer-/Device-Rechte und Worker-Bestätigung vor Nachrichten-Commit in [PR #48](https://github.com/niklaskastning/foundry/pull/48). Web/Windows-Renderer lesen bestätigte Referenzen über Main; lokale Blob-URLs bleiben Ansichten mit begrenzter Lebensdauer. Negative Besitzer-/Instanz-/Hash-/Unvollständigkeits-/Kapazitätsfälle, Wiederaufnahme, verlorene Antworten und Neustart sind gegen echtes isoliertes PostgreSQL/Datei/HTTP geprüft. Main und dedizierter Worker sind auf `349f33685` mit Schema 6 und aktiviertem Artefaktprofil deployt, Konfiguration/Identität/Readiness bestätigt. Echter Worker-Upload von 308.000 Bytes vor Nachrichten-Commit und identischer Command-Retry bestanden. Abschließender Browser-Nachweis: A lädt über die Artefakt-API in den echten Main hoch; nach Schließen/Widerruf von A und Stop des Ursprungsworkers mit leeren cgroups öffnet und lädt frischer B über die Main-Dateiansicht herunter. Nach Main-Neustart bei weiterhin gestopptem Worker erneut 308.000 Bytes und SHA-256 `cebd89450f70b41ccb6d67e0c7bd914c98351795f21e772f57952a333ef9f697`, unveränderte Referenz. HTML/SVG bleiben Quelltext ohne Skript/iframe, Hell-/Dunkel-Durchlauf ohne erfasste Warnung; frühere Theme-Warnung dabei nicht reproduziert. Zwei isolierte Browserprofile nutzten eine temporäre Loopback-Test-Anmeldegrenze mit echten, anschließend widerrufenen Main-Sessions; dies behauptet keine neue öffentliche Access-/Windows-Abnahme. Der Maintainer bestätigt die öffentliche UI positiv. [PNG-/Hash-Evidence auf GitHub](https://github.com/niklaskastning/foundry/releases/tag/untagged-008b5e0dfa767d863675) liegt in einer manuellen Entwurfsablage. Betreiberhelfer einschließlich Connector-Verbindungsereignis, Writer-Sperren und schemaabhängiger Recovery real geprüft; Dienste wieder bereit, null Provider-Starts. Windows-Download bleibt die getrennte Produktlücke. P38b ist das nächste Paket und noch nicht implementiert.
- [ ] **Nächste Entwicklung nach P38a:** P38b → P19 → P20 → P21 → P49 → P22 → P23 → P24 → G4; danach die unten beschriebene Reihenfolge. Zentrale Threads/Anhänge sind noch nicht durchgängig integriert und müssen vor erstem Workflow-Dispatch geräteunabhängig gesichert werden.

Betriebsstand: Basis vor Abschluss von PR #48 war Fork-main `a3c1dec11` (PRs #45–#47 und Maintainer-Betriebsregeln integriert).
Main und dedizierter Worker laufen für die P38a-Entwicklungsabnahme auf dem geprüften
PR-Stand `349f3368541ffa0374b81912b19efee002c1d4f4`; Main-Image
`sha256:3f79b3771cbb7b09d6b17bf321c1dad198ec453fd15735beee2cee09cdf02072`,
Schema 6, Artefaktprofil/Gateway/Readiness/Betreiberbindung/Konfigurationsabgleich
bestätigt, Migrator NOLOGIN. Main-Recovery `/var/lib/foundry-deploy/upgrade-ygxpv7tf`,
Profil-Recovery `/var/lib/foundry-deploy/artifacts-ya56rewn`, Worker-Konfigurations-/SQLite-Recovery
`/var/lib/foundry-deploy/worker-artifacts-qt4_rph3`. Der Worker wurde aus dem sauberen
Checkout dieses Commits gebaut; Docker-Archiv-Metadaten ersetzen dessen Sauberkeitsprüfung nicht.
Dienstkonto `foundry-worker`, gemeinsame `foundry-host.slice` mit `cpu.max=100000 100000`,
`memory.max=2147483648`, `pids.max=256`; `codexG3`/CLI `0.156.1` nach Wiederanlauf bereit.
Ressourcen-Durchsetzung unter Last bleibt offen. Die früheren vier G3-Ergebnisse bleiben erhalten;
erlaubte eigene Fixture `/srv/foundry-worker/workspaces/g2/g3-acceptance-5e75qro4`.

Die drei Ausführungen besitzen monotone Generationen 1/2/3. Generation 1 endete nach
der 120-Sekunden-Grenze bestätigt `stopped`; Generation 2 meldet bestätigtes natives
Ende und ein zum Run gehörendes `completed`-Manifest mit `ready`-Checkpoint;
Generation 3 endete nach ausbleibender Lease-Erneuerung und geschlossenem Launch-Socket
bestätigt `stopped`, ohne Checkpoint-Erfolgszusage. Der manuelle Konkurrenzstart
endete in der Workspace-Vorbereitung `failed`, ohne nativen Provider-Turn. Geänderte
Anfrage unter gleicher Command-ID, alte Generation, unbekannter Read, zukünftiger
Follow-Cursor und Cancel-ID-Verwechslung wurden real abgewiesen; alte Manifeste
blieben erhalten. Der Approval-Pfad bleibt aktiv: der Prüfer bestätigt ausschließlich
eine feste Liste von Befehlen für diese Fixture über den bestehenden Service.
Keine neue Login-Testfolge, kein Main-Update, kein GitHub-/Publishing-Zugriff.

Der [Betreiberlauf](../../deploy/fork/worker/README.md#begrenzter-echter-g3-auftrag)
für Git-Objekt, Dateiinhalt und persistente Zählungen wurde nach dem Idle-Neustart
real bestätigt. Restart-Snapshot
`/var/lib/foundry-deploy/worker-g3-restart-n_4xor5l/execution-snapshot.json`, alter
Worker-PID `3664234`, nach Neustart Host/Connector `112498`/`112499`; Environment-ID
`3bf8c5a6-bd4e-444d-9279-6bcad20f396e` unverändert. Ergebnisnachweis für Command
`g3-16fd60c2-6e02-42be-ba87-ceed55a2af57`, Generation 2, ist unabhängig gespeichert;
keine neue Ausführung beim Neustart.

Der anschließende aktive Crash-Prüfer wurde real ausgeführt: privater Record
`/var/lib/foundry-deploy/worker-g3-active-2d5hmvo7/probe.json`, eigene Fixture
`/srv/foundry-worker/workspaces/g2/g3-acceptance-restart-iu_2px8m`, Command
`g3-restart-fa8c64e1-9844-4cf7-8142-8e80231277d9`. Native Command-Freigabe war offen,
als ausschließlich die Worker-Dienste beendet wurden. Nach Neustart ist Codex
bereit; zunächst blieb Generation 4 korrekt unklar und reserviert. Die lesende
native Diagnose bestätigte den ursprünglichen Turn als `interrupted`, vollständige
Historie und keine laufenden Turns/Befehle. Anschließend wurde Worker-Release
`6643d6439c9e2d02069240765d25cc76f3408240` unter der tatsächlichen Dienst-UID
geprüft und installiert, mit privater Konfigurations-/SQLite-Recovery unter
`/var/lib/foundry-deploy/worker-g3-recovery-8r5u81yp`. Der Read-Service öffnete den
Harness ohne Thread-/Turn-Fortsetzung und erhob den nativen Stop erneut.
`active-recovery-verify` bestätigt am 3. November Generation 4 als `stopped`,
positives Writer-Ende, passendes Stop-Manifest, freigegebene Reservation und
unverändert genau einen Run/Attempt/nativen Turn. Keine direkten SQL-Atteste,
kein Ersatzauftrag. Frische Readiness um 09:10:26Z: `codexG3`, CLI `0.156.1`,
`activeRuns=0`; Host/Connector-PIDs `319318`/`319319` im bestehenden Dienstkonto
und der gemeinsamen Slice. Main wurde nicht geändert. Evidence und fokussierte
Regressionstests in [#45](https://github.com/niklaskastning/foundry/pull/45).

Windows war für diese Unterbrechungsprobe nicht verfügbar. Zwei andere Clients
hatten dieselbe Instanz verwendet; Main wurde erst nach dem Crash neu geöffnet
und über `Instance sign in` angemeldet. Eine Worker-/Threadseite war während des
Crashs nicht als aktive Reconnect-Probe geöffnet. Das belegt
Katalogzugang nach Anmeldung, noch keine fortgesetzte Worker-/Thread-Verbindung
in beiden Clients. Ablauf einer Main-/Foundry-Session und Worker-Reconnect bleiben
getrennt zu klären; keine Zuordnung als Crash-bedingter Login-Fehler und keine
neue pauschale Login-Testfolge. Der funktionale G3-Abschluss ist unabhängig davon
bestätigt; P18b und P47 sind als inaktive Grundlagen umgesetzt. Automatisierte
Provider-Starts folgen erst nach P38a/P38b und P19.

G1/G2 sind damit für die Entwicklungsfortsetzung ausreichend praktisch geprüft, aber nicht vollständig abgenommen. Die Restabnahmen bleiben sichtbar; keine Freigabe für Betrieb ohne Access, neue Infrastruktur oder bezahlte Turns ableiten. Nach G3 darf die isoliert vorgezogene P18a-Grundlage integriert weitergenutzt werden. Änderungen und neue Nachweise in ihren jeweiligen PRs belegen und die betroffenen Häkchen hier aktualisieren; Issue #13 dient als Nachweisarchiv.

## Regeln für ein Arbeitspaket

Ein Paket ist ein vorgesehener PR mit einem prüfbaren Ergebnis. Es enthält die für dieses Ergebnis notwendigen Contracts, Service-/Adapteränderungen, gezielten Tests und gegebenenfalls einen schmalen UI-Anschluss. Keine Mischung mit Branding, Dependency-Upgrades oder allgemeinem Cleanup. Ein Paket ist zu groß, wenn Reviewer mehrere unabhängig freigebbare Verhaltensänderungen beurteilen müssten: vor Umsetzung im Issue in Unterpakete wie P08a/P08b teilen, eindeutige Abhängigkeiten und Teilgates festhalten und diese Planung aktualisieren. Nicht erst am Ende einen Sammel-PR erzeugen.

Jedes Paket erhält **Gate Pxx**: alle unter „Nachweis“ genannten Erwartungen müssen am finalen Head erfüllt sein. Standardmäßig gelten außerdem:

- Fokus-/Regressionstests an der niedrigsten passenden Schicht; Fehler-Injektion für durable Grenzen und Auth. Reine Dokument-/Copy-/Visualänderungen brauchen keine Spiegeltests. PostgreSQL-Locks und Migrationen gegen isoliertes echtes PostgreSQL prüfen.
- Vor Push `vp run check:changed`; keine unaufgeforderten repo-weiten Checks, keine zusätzlichen automatischen Actions-Jobs. Artefakt-Builds manuell nur an den genannten Integrationsgates.
- Bei sichtbarer UI-Änderung ein integrierter Pass im realen Client; bei Auth-/Transportänderungen zählt ein Backend-Test allein nicht als Windows-Nachweis. Replay statt bezahlter Agent-Turns, außer beim ausdrücklich freigegebenen Provider-Nachweis.
- PR nennt getesteten SHA/Build, Voraussetzungen, genaue Befehle oder Bedienfolge, erwartetes/beobachtetes Ergebnis, negative Fälle und relevante Grenzen. Keine Tokens oder Pairing-Links in Evidence. Modell-/MCP-Instruktionen benötigen passende Evals gemäß [Eval-Regeln](../../evals/README.md).
- Ergebnis darf hinter deaktivierter Capability landen, wenn sein Paketgate bestanden ist. Eine abhängige Produktfunktion bleibt bis zum übergeordneten Gate gesperrt. Merge bedeutet weder Deployment noch Produktabnahme.

Ein fehlgeschlagener oder nicht ausführbarer Nachweis bleibt **offen/blockiert**, niemals „bestanden mit TODO“. Zuerst Fehler beheben oder einen begrenzten Alternativweg entscheiden; keine Sicherheitsprüfung abschalten. Kein automatischer Architekturwechsel, Providerwechsel oder Infrastrukturkauf. Der Maintainer entscheidet Merge und produktive Aktivierung; Agenten bereiten Änderung, Tests und konkrete Handoffs vor.

## Gate-Übersicht und kritischer Pfad

| Gate                                | Umfang / notwendige Paketgates                          | Freigabe und explizite Stop-Bedingung                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 · Instanzeinstieg                | P01–P05                                                 | Web/Windows melden sich im freigegebenen Auth-Modus an. Access und native Foundry-Anmeldung benötigen getrennte Nachweise                                                  |
| G2 · Device-Zugriff                 | G1, P06–P12                                             | Zwei Clients sehen ein Device; HTTP/WS/Dateien/Widerruf über Main funktionieren. Ohne Scope-/URL-Bindung keine Host-Agentenfreigabe                                        |
| G3 · Dauerhafter Worker             | G2, P13–P17                                             | Launch/Follow/Cancel und Checkpoint ohne Eltern-Agenten; bei verlorenem Ack genau ein Thread. Unklarer Stop verhindert Wiederbelegung                                      |
| G4 · Workflow-MVP                   | G3, P18a/P18b, P47, P38a/P38b, P19–P24, P49             | Factory-Definition, Navigation und Inbox tragen den manuellen/GitHub-Polling-Weg bis zum geprüften PR, mit Freigabe und Recovery. P25 separat nur für öffentliche Webhooks |
| G5 · Dauerbetrieb                   | G4, P48, P26–P27                                        | Isolierter Restore und kontrolliertes Upgrade bestanden; kein Dauerbetrieb allein aufgrund gesunder Container                                                              |
| G6 · Wiederverwendung / Multi-Repo  | G5, P47, P28–P30; P31 nur für Multi-Repo-Thread         | Gepinnte Vorlagen, begrenzter Fan-out und getrennte Repo-Ergebnisse. Keine Zusage eines Multi-Repo-Threads ohne P31                                                        |
| G7 · Mehrere Worker                 | G5, P32–P33                                             | Explizite Platzierung/Kapazität und Partition-Recovery; kein zweiter Writer bei unklarem Altversuch                                                                        |
| G8 · Sandboxes                      | G7, P34–P40                                             | Benutzer- und Workflow-Nutzung teilen Provisionierung/Quoten; Setup, Auth, Archiv und Cleanup nachgewiesen                                                                 |
| G9 · Optionale Connectoren / Memory | Je benötigtes Paket P41–P43 plus dessen Voraussetzungen | Jede Integration wird separat abgenommen; nicht für G1–G8 erforderlich                                                                                                     |
| G10 · Optionale Identität / Hosting | P44–P46 nur nach Bedarf und jeweiligen Voraussetzungen  | IdP, Device-Gruppen und Hosting einzeln freigeben; kein implizites Enterprise-/HA-Versprechen                                                                              |
| G11 · Factory als Produkt           | G5, P47–P49                                             | Definition atomar aus UI/Dateien/Git aktivieren; persönliche Inbox und Factory-Navigation verwenden dieselben Aufträge.                                                    |
| G12 · Interaktive Zusammenarbeit    | G11, G6, P50–P53, P58                                   | Koordinator, T3-Übernahme/Rückgabe, Ressourcen und API/MCP greifen auf dieselben autorisierten Services zu.                                                                |
| G13 · Messen und verbessern         | G11, P28, P54–P57                                       | Metriken und Evaluationsbelege nachvollziehen; Benchmark isoliert ausführen; Verbesserung nur als geprüften Vorschlag übernehmen.                                          |
| G14 · Zusätzliche Einsatzfälle      | Je benötigtes Teilpaket P59/P60                         | Connector oder Browser-/Incident-Vorlage separat abnehmen; keine pauschale Freigabe aller Integrationen.                                                                   |

Kritischer Pfad ab der gesetzten Basis: **P17 / G3 → Factory-MVP mit P47, P38a/P38b und P49 / G4 → Git-Verwaltung und Recovery / G5 + G11**. G6/G12 (Zusammenarbeit), G13 (Qualität) und G7/G8 (Worker/Sandboxes) bauen danach auf derselben Factory auf. Ihre Gate-Nummern bleiben stabile Referenzen, keine zeitliche Sortierung. P26 kann schon nach P18 vorbereitet werden; die Restore-Abnahme umfasst auch die bis G5 eingeführten Definitions-, Inbox- und Git-Owner-Daten. P25 ist optional und blockiert den Polling-MVP nicht. G6 ist keine Voraussetzung für eine Sandbox mit einem Repository.

## Umsetzungsreihenfolge ab P17

**Gesetzte Basis:** P01–P16 werden für diese Neuordnung als umgesetzt behandelt; ihre Paketbeschreibungen, Reihenfolge und Verträge bleiben unverändert. Das ist keine nachträgliche Bestätigung noch offener Integrationsnachweise. P03N und etwaige offene G1-/G2-Nachweise behalten ihren bisherigen gesonderten Abnahmeweg. Umgeordnet wird ausschließlich die noch ausstehende Arbeit ab P17.

Die folgenden Etappen bestimmen auch die Reihenfolge der Paketbeschreibungen. Die IDs bleiben erhalten, damit bestehende Architektur-, Issue- und PR-Verweise gültig bleiben. Die Produktanforderungen und Seitenaufteilung stehen in [Architektur, Abschnitte 3.2 und 12](architecture.md#32-zielvision-eine-software-factory-innerhalb-von-t3-code).

1. **Worker abschließen:** P17 und G3 sichern die gemeinsame Workspace-/Writer-Grenze vor automatisierter Factory-Arbeit.
2. **Factory als erster Workflow-MVP:** P18a → P18b → **P47** → **P38a → P38b** → P19 → P20 → P21 → **P49** → P22 → P23 → P24 → G4. Factory as Code liegt vor dem Formulareditor; zentrale Thread-/Attachment-Persistenz kommt vor dem ersten Dispatch. Navigation und persönliche Inbox gehören schon zur ersten nutzbaren Factory. P22/P24 können nach P19 unabhängig vom UI-Anschluss entstehen; G4 integriert alles.
3. **Git-Verwaltung und belastbarer Betrieb:** **P48** → P26 → P27 → G5 + G11. Git-Synchronisation nutzt den bereits vorhandenen GitHub-Zugang; Restore und Rollout prüfen anschließend die vollständige erste Factory. Vor G5 bleiben Nutzung und Nachweise auf isolierte Entwicklungs-/Testumgebungen begrenzt.
4. **Zusammenarbeit und wiederverwendbare Agenten:** **P51 → P58** für T3-Übernahme/Rückgabe und API/MCP; P28 → **P52** für Katalog und Ressourcen; P29 → **P50 → P53** für begrenzte Koordination, Triage und Review; danach P30/P31 und G6/G12. Der Host-Worker genügt; Pool-/Sandbox-Erweiterungen werden erst mit ihren jeweiligen Fähigkeiten freigegeben. P50 bleibt optional, ohne Koordinator bleibt lediglich dessen Anteil an G12 offen.
5. **Qualität früh nutzbar machen:** **P54 → P55 → P56 → P57** und G13 liefern Dashboard, Scorers, Benchmarks und belegte Verbesserungsvorschläge vor dem Sandbox-Ausbau. Host-Trials verwenden getrennte verwaltete Workspaces und autorisierten eigenen Code; Sandbox-Trials folgen erst mit G8. Dieser Pfad kann nach G5 und P28 unabhängig vom Multi-Repo-Ausbau entstehen.
6. **Ausführung skalieren:** P32/P33 und G7, danach P34–P40 und G8. Dieser Pfad kann bei konkretem Kapazitäts-/Isolationsbedarf schon nach G5 neben Zusammenarbeit und Qualität beginnen; G12/G13 sind keine Voraussetzungen. Er erweitert die vorhandenen Factory-Ressourcen und Handoffs.
7. **Bedarfsabhängige Eingänge und Vorlagen:** P25, P41–P43, P59/P60 mit G9/G14 jeweils nach ihren Voraussetzungen. Diese Pakete warten nicht pauschal auf den Sandbox-Ausbau; nur P60a benötigt G8. P44–P46/G10 bleiben separat bedarfsabhängig.

**Auswirkungen auf Abhängigkeiten:** P38 wird in zentrale Artefaktpersistenz (P38a), fortlaufende Thread-Archive (P38b) und späteres Sandbox-Cleanup (P38c) geteilt. P38a/P38b werden vor P19 und damit G4 umgesetzt; P38c bleibt bei G8 nach P36. Dies umfasst alle über Foundry verwalteten Threads, auch auf dauerhaften Workern; lokale T3-Ausführung und persönliche Profile bleiben getrennt. P47 benötigt künftig P18a/P18b statt G5 und wird Voraussetzung von P19 und P21. Damit entsteht kein zweites Definitionsformat, das nach dem MVP migriert werden müsste. P49 folgt direkt auf P21/P47 und wird Teil von G4. P48 folgt auf den GitHub-Publish-Pfad und wird Voraussetzung von P27/G5; dadurch prüft die erste Betriebsabnahme auch Git-verwaltete Definitionen. G11 fällt anschließend mit G5 zusammen. P51/P58, P52/P50/P53 und P54–P57 werden unter ihren bestehenden Voraussetzungen einsortiert; neue Fähigkeiten von Runnern, Scorers oder Benchmarks erweitern das Schema erst mit ihrem Paket. Keine Factory-Vorziehung ersetzt G3, Recovery, Rechteprüfungen oder Sandbox-Isolation.

G1 wird pro Betriebsart abgenommen: zunächst **G1-Access** für unser Deployment, später **G1-Nativ** für den eigenständig sicheren Betrieb ohne Cloudflare Access. G1-Nativ benötigt zusätzlich P03N sowie die Onboarding-/Transportnachweise von P05 ohne Access. Der erste G2-Durchstich darf auf G1-Access aufbauen; seine Freigabe gilt dann nur für diesen Modus. Vor Freigabe desselben Funktionsumfangs ohne Access müssen G1-Nativ und die betroffenen HTTP-/WebSocket-/Device-Grenzen ohne vorgeschaltetes Access erneut geprüft werden. Native Foundry-Authentifizierung ist ein verbindliches Produktziel, nicht vom optionalen P44 abhängig. Sie wird separat umgesetzt und nicht stillschweigend in P04 eingeschoben.

## Gesetzte Basis · P01–P16

### P01 · Instanzidentität und Protokollvertrag

**Voraussetzungen:** keine.

**Ergebnis und Umfang:** Versionierten Instanz-Descriptor mit stabiler instanceId, Main-environmentId, zulässigen Auth-Verfahren und Capability-Aushandlung einführen. IDs über Neustarts erhalten; inkompatible Versionen ausdrücklich ablehnen.

**Abgrenzung:** Noch keine Registrierung, Gateway-Verbindung oder Teamverwaltung.

**Gate P01 – Nachweis:** Neustart liefert dieselbe Identität; falsche/fehlende Protokollversion wird verständlich abgelehnt; Descriptor enthält keine Secrets oder Device-Liste.

### P02 · PostgreSQL-Grundlage für Instanzdaten

**Voraussetzungen:** P01.

**Ergebnis und Umfang:** Eigene Instanz-Migrationen für Identität, Betreiberbindung und Zugangsgenerationen in fork_connect; getrennte Runtime-/Migrationsrolle, Transaktionsschnittstelle und Readiness einführen.

**Abgrenzung:** Kein Relay-Schemaimport, keine Automation-Tabellen und keine SQLite-Portierung.

**Gate P02 – Nachweis:** Auf isoliertem PostgreSQL: Neuinstallation, Wiederholung, konkurrierender Migrationsstart und inkompatibles Schema prüfen. Runtime kann keine DDL ausführen; DB-Ausfall blockiert Readiness statt Ersatzdaten anzulegen.

### P03 · Access-Nachweis und Foundry-Benutzersession

**Voraussetzungen:** P01, P02.

**Ergebnis und Umfang:** Validierten Access-Subject an den vorkonfigurierten Betreiber binden; eigene Session, Ablauf, Erneuerung, CSRF-/Origin-Prüfung und Logout als Services bereitstellen.

**Abgrenzung:** Ein Benutzer; keine Selbstregistrierung, Rollenoberfläche oder Clerk-Integration.

**Gate P03 – Nachweis:** Gültiger Nachweis funktioniert; gefälschte Signatur, falscher Issuer/Audience, fremder Subject und abgelaufener Nachweis scheitern. Logout entwertet die Sitzung; Header-Spoofing schafft keinen Zugang.

### P03N · Native Foundry-Anmeldung ohne Cloudflare Access

**Voraussetzungen:** P01, P02, P03; vor Umsetzung genau ein natives Anmeldeverfahren und dessen Credential-/Recovery-Vertrag festlegen. Bestehende Services wiederverwenden; die Access-spezifische Bindung ausdrücklich von der internen Betreiberidentität trennen.

**Ergebnis und Umfang:** Kontrollierte Erstbesitzer-Einrichtung, Credential-Verwaltung, Missbrauchsschutz und native Anmeldung an dieselbe interne Betreiberidentität und Foundry-Autorisierung anbinden. Session-Ablauf, Erneuerung, Logout, Widerruf und Recovery ohne externen IdP bereitstellen. Den expliziten Wechsel zwischen nativer und Access-Anmeldung mit Erhalt der Instanz-/Betreiberidentität und Behandlung vorhandener Sessions unterstützen. Vor Umsetzung bei Bedarf in eigenständig prüfbare PRs teilen.

**Abgrenzung:** Kein anonymes öffentliches Setup mit „erster Besucher wird Admin“, kein Auth-Bypass bei fehlender Konfiguration, keine Teams oder Pflicht zu Cloudflare/Clerk. Verfahren wie Passwort oder Passkey werden hier noch nicht vorweggenommen. Bisheriges T3-Pairing ist kein Nachweis dieses neuen Instanz-Logins.

**Gate P03N – Nachweis:** Ohne Cloudflare oder externen IdP: autorisierte Erstinitialisierung einschließlich konkurrierender Versuche, Login und falsche Credentials, begrenzte Fehlversuche, Session-Ablauf/Erneuerung, Neustart, Logout/Widerruf und Recovery prüfen. Unauthentifizierte HTTP-/WebSocket-Zugriffe sowie gefälschte Proxy-/Access-Header scheitern. Moduswechsel erhält Identitäten und reaktiviert keine widerrufenen Sessions; Fehlkonfiguration oder DB-Ausfall öffnet keinen Zugang. G1-Nativ ergänzt reale Web-/Windows-Abnahme.

### P04 · Windows-Transport für Access-Anmeldung

**Voraussetzungen:** P03.

**Ergebnis und Umfang:** Für Google als IdP den freigegebenen Systembrowser-/Managed-OAuth-Weg mit PKCE, zustandsgebundenem Loopback-Callback und instanzisolierter Credential-Speicherung prüfen und implementieren. HTTP und WebSocket müssen denselben autorisierten Access-Kontext nutzen. Die Transportanbindung vom Anmeldeadapter trennen, damit P03N später ohne Cloudflare-Abhängigkeit angeschlossen werden kann.

**Abgrenzung:** Kein Service-Token im Client; keine pauschale Freigabe von Node/IPC für Remote-Seiten. Keine Umgehung der Google-Beschränkung für eingebettete Browser. Managed OAuth für die konkrete Anwendung, Callback-Zulassung und Auth-Header-Kompatibilität vor Freigabe nachweisen; keine automatische Cloudflare-Konfigurationsänderung.

**Gate P04 – Nachweis:** Auf Windows mit echtem IdP: Login, API, WebSocket, Ablauf, Neustart und Logout nachweisen. Remote-Login kann keine privilegierten IPCs nutzen; Session A wird nicht an Instanz B gesendet. Ist kein Windows-Testhost verfügbar, bleibt G1 offen.

### P05 · Instanz-URL und Onboarding in Web/Windows

**Voraussetzungen:** P01, P03, P04.

**Ergebnis und Umfang:** Runtime-Instanzwahl, verifizierten Descriptor und verständliche Login-/Fehlerzustände an vorhandenen Connection-Supervisor anbinden. Wechsel und Entfernen der Instanz anbieten.

**Abgrenzung:** Noch kein Device-Katalog; keine zweite Reconnect-Steuerung oder Mehrinstanz-Parallelität.

**Gate P05 – Nachweis:** Frisches Profil gelangt per URL zur angemeldeten Main Node. HTML-Access-Redirect wird nicht als JSON-Fehler versteckt. Unerwarteter Identitätswechsel und fremde Redirect-Ziele werden gestoppt; Entfernen leert nur zugehörige Sessions/Caches.

### P06 · Device-Registrierung und einmaliges Enrollment

**Voraussetzungen:** G1.

**Ergebnis und Umfang:** Device-Schlüssel, einmalige keygebundene Enrollment-Freigabe, Registry-Persistenz und Widerruf als Backend-Service implementieren; begrenzten operatorseitigen Enrollment-Befehl bereitstellen.

**Abgrenzung:** Noch keine automatische Cloudflare-Provisionierung, kein Device-Verkehr und keine Benutzergruppen.

**Gate P06 – Nachweis:** Verlorene Antwort und Retry liefern dieselbe Registrierung. Abgelaufenes oder fremdschlüsselgebundenes Token scheitert; Doppelverbrauch erzeugt keine zweite Identität; Widerruf bleibt nach Restart bestehen.

### P07 · Ausgehender Device-Kanal

**Voraussetzungen:** P06.

**Ergebnis und Umfang:** Authentifizierten Connector mit Version/Generation, Heartbeat, Reconnect und Bindung an genau sein lokales Environment einführen. Im Access-Betrieb zusätzlich das Access-Machine-Credential sicher konfigurieren; der Device-Nachweis bleibt in beiden Betriebsarten erforderlich.

**Abgrenzung:** Keine beliebige URL als Proxy-Ziel; noch keine vollständige Client-Weiterleitung.

**Gate P07 – Nachweis:** Device ohne eingehend erreichbaren Port verbindet sich; falsche Identität/Generation wird abgewiesen. Tunnelunterbrechung und Main-Neustart werden abgeglichen; nur eine aktuelle Verbindung darf eine Registrierung bedienen.

### P08 · Gateway-Session und HTTP-Autorisierung

**Voraussetzungen:** P03, P07.

**Ergebnis und Umfang:** Clientauth an Main terminieren, Device-Session mit begrenzten Scopes erzeugen und typisierte HTTP-Routen vermitteln. Akteur/Grant und korrekte URL-Bindung in Auth-Adapter erhalten.

**Abgrenzung:** Kein universeller Admin-Proxy, keine Abschaltung von DPoP und kein beliebiger Content-Proxy.

**Gate P08 – Nachweis:** Scope-Eskalation, falsches Environment, DPoP-Replay und Path-Traversal ablehnen. Device-Cookies/Redirects werden nicht blind weitergereicht. Read-only-Grant kann keine Mutation auslösen; gültiger Read erreicht genau das registrierte Ziel.

**Technische Aufteilung:** P08a führt die Main-seitige Ausgabe und erneute Prüfung kurzlebiger Grants mit Bindung an Foundry-/T3-Session, Akteur, Device, Environment und Kanalgeneration ein. P08b verwendet diese Grenze für Device-seitige Sessions und die begrenzte HTTP-Weiterleitung. Bestehende T3-Sessions allein tragen diese Delegationsbindung noch nicht; die Autorisierungsgrenze und ihre Transport-Einlösung werden daher separat geprüft. P08a bewirbt noch keine Gateway-Capability und besteht allein nicht Gate P08. Historische Reihenfolge und Teilnachweise: [Issue #13](https://github.com/niklaskastning/foundry/issues/13).

### P09 · WebSocket-, Thread- und Terminaltransport

**Voraussetzungen:** P08.

**Ergebnis und Umfang:** Begrenzte Stream-Kanäle, Socket-Tickets und Anschluss an bestehende Client-Transportlogik implementieren. Steuerverkehr vom Datenrückstau trennen.

**Abgrenzung:** Keine unbeschränkten Buffers; Terminaleingaben nicht blind wiederholen.

**Gate P09 – Nachweis:** Replay-Turn streamt über Main. Langsamer Empfänger, Kanalabbruch und Reconnect führen zu Backpressure oder sichtbarem Abbruch. Bestätigte Mutationen werden nicht dupliziert; unbestätigte Terminaleingaben werden als unsicher markiert.

### P10 · Dateien, Diffs und Attachments über Gateway

**Voraussetzungen:** P08, P09.

**Ergebnis und Umfang:** Benötigte Datei-/Diff-/Attachment-Pfade inklusive Größenlimits und bestätigtem Chunk-Resume anbinden. Content-Type/Download-Behandlung von privilegierter UI-Origin trennen.

**Abgrenzung:** Keine aktive Projekt-Preview unter der Instanz-Origin, kein Object-Storage-Ausbau.

**Gate P10 – Nachweis:** Datei und Attachment mit Hashvergleich übertragen; unterbrochenen Transfer fortsetzen. Große/unerlaubte Payloads kontrolliert ablehnen; Device-HTML kann weder Script noch Service Worker an der Main-Origin ausführen.

### P11 · Grants, aktive Sessions und Widerruf

**Voraussetzungen:** P06, P08, P09.

**Ergebnis und Umfang:** clientAccess, automationExecution und sandboxProvisioning getrennt modellieren; lokale Zugangsprüfung und aktive Stream-/Session-Invalidierung an Grant-Generationen koppeln.

**Abgrenzung:** Noch ein Betreiber; kein transitive Trust und keine Zusage eines Fern-Kills offline laufender Prozesse.

**Gate P11 – Nachweis:** Widerruf schließt betroffene aktive Verbindungen und verhindert neue; andere Grants bleiben erhalten. DB-Ausfall lässt keine unbegrenzt gültige alte Autorisierung zu. Unabhängige direkte T3-Verbindung wird nicht als widerrufener Instanzzugang ausgegeben.

### P12 · Device-Katalog und interaktive Auswahl

**Voraussetzungen:** P05, P06, P09, P10, P11.

**Ergebnis und Umfang:** Registrieren/Trennen, Online-/Offline-Zustand und Device-Auswahl im gemeinsamen Client integrieren. Vorhandene Thread-/Projektansichten verwenden.

**Abgrenzung:** Keine Automation-Zustandsmaschine; Sichtbarkeit ist keine automatische Ausführungsfreigabe.

**Gate P12 – Nachweis:** Zwei frische Clients desselben Betreibers sehen dasselbe Device ohne Pairing je Client/Device und öffnen dort denselben Testthread. Offline bleibt sichtbar; Entzug entfernt Zugriff in beiden Clients.

### P13 · Host-Worker als eigener Linux-Dienst

**Voraussetzungen:** G2.

**Ergebnis und Umfang:** Installations-/Update-/Stop-Verfahren für einen isolierten Foundry-Host-Dienst mit eigenem Home, Dienstkonto, erlaubten Workspace-Wurzeln und Ressourcenbudget liefern.

**Abgrenzung:** Kein Zugriff auf persönliches T3-State, kein Host-Home-Mount in Main und keine Sandbox-Zusage.

**Gate P13 – Nachweis:** Auf isoliertem Zustand Installation, Neustart, Upgrade und Entfernung prüfen. Environment-ID bleibt erhalten, bestehendes T3 bleibt erreichbar. Betriebskonto/Dateirechte und ohne Interaktiv-Shell wirksamer PATH sind dokumentiert.

### P14 · Provider-Bereitschaft und Codex-Bindung

**Voraussetzungen:** P13.

**Ergebnis und Umfang:** Codex-Installation/Anmeldung im Host-Worker und Capability-Abfrage verbinden. online, providerReady und capacityAvailable getrennt melden; fehlende Anmeldung mit Handoff anzeigen.

**Abgrenzung:** Keine Credentials vom bestehenden Benutzer kopieren; keine anderen Provider oder automatische API-Abrechnung.

**Gate P14 – Nachweis:** Fehlendes Binary, abgelaufene Anmeldung und unbekannte Provider-Version liefern korrekten Status. Neustart erhält autorisierte Konfiguration. Zuerst Replay; nur mit expliziter Freigabe ein minimaler echter Codex-Turn.

### P15 · Idempotentes Launch-Receipt ohne Eltern-Agenten

**Voraussetzungen:** P11, P13.

**Ergebnis und Umfang:** Servicebasierten Worker-Launch mit stable Command-ID und durablem Receipt an ThreadLaunchService anbinden; normale Projekt-/Provider-Rechte anwenden.

**Abgrenzung:** Keine künstlichen Agenten-Elternthreads und keine zweite Provider-Spawn-Implementierung.

**Gate P15 – Nachweis:** Crash vor/nach T3-Command-Commit und verlorene Antwort injizieren: Wiederholung findet exakt denselben Thread. Nicht berechtigtes Projekt oder deaktivierter Provider startet keinen Prozess.

### P16 · Follow, Ergebnisfinalisierung und Cancel

**Voraussetzungen:** P15.

**Ergebnis und Umfang:** Follow/Read/Cancel als Services, lokalen Lease-Watchdog und bestätigten Ergebnisabschluss einschließlich Checkpoint/Manifest implementieren.

**Abgrenzung:** Noch kein Workflow-Graph; Lease-Ablauf ist kein Beweis für Prozessende.

**Gate P16 – Nachweis:** Turn fertig, Checkpoint offen bleibt finalizing. Cancel während Start und laufendem Turn endet erst nach bestätigtem Stop. Verlorene Verbindung erzeugt unklaren Status statt zweiten Writer; alte Generation überschreibt kein Ergebnis.

## Worker-Abschluss · G3

### P17 · Workspace-Belegung für manuelle und automatisierte Arbeit

**Voraussetzungen:** P15, P16.

**Ergebnis und Umfang:** Verwaltete Checkout-/Worktree-Allokation, Writer-Reservierung und Freigabe mit Recovery bereitstellen.

**Abgrenzung:** Ein Repository je Auftrag; keine implizite Synchronisation mit anderen Devices oder Sperrgarantie für fremde Host-Prozesse.

**Gate P17 – Nachweis:** Zwei Writer auf demselben verwalteten Checkout werden serialisiert oder getrennten Worktrees zugeordnet. Restart verliert aktive Reservierung nicht; Cancel gibt erst nach Stop frei; Nutzerdateien außerhalb verwalteter Wurzeln bleiben unberührt.

### P14Z · Zentrale Verbindungen und delegierte Provider-Autorisierung

**Voraussetzungen und Einordnung:** G3 für die Integration mit realen Ausführungen; vorhandene Secret-/Provider-Adapter wiederverwenden. Die G4-Reihenfolge P18b → P47 → P38a/P38b → P19 ff. bleibt erhalten. P14Z ist vor zentral autorisierten zusätzlichen dauerhaften Workern (P32) umzusetzen; P37 und P52 bauen darauf auf. P23 liefert zuvor den zentralen GitHub-App-Teilzugang für Publishing, ohne vollständige Provider-Delegation zu behaupten.

**Ergebnis und Umfang:** Verbindungen einmal über Foundry einrichten, prüfen, erneuern, trennen und erneut anmelden. Main besitzt Verbindungsidentität, Kontobindung und Freigaben; ein Credential-Service liefert autorisierten dauerhaften Devices und kurzlebigen Sandboxes nur die benötigte Laufzeitberechtigung. Neue Environments übernehmen freigegebene Bindings ohne erneute manuelle Anmeldung je Environment. Gerät, Factory/Agent und Auftrag begrenzen die Nutzung; Enrollment allein erteilt keinen Zugang. Zentrale Auswahl und fehlende Anmeldung sind auch für manuelle Threads sichtbar. Ein Refresh-Owner je erneuerbarem Konto, Ablauf, Rotation, Entzug und Wiederverbindung gehören zum Vertrag.

**Teilpakete:** P14Za implementiert zentrale Verbindungsverwaltung und genau einen nachgewiesenen Codex-Delegationspfad für dauerhafte Worker. Weitere Adapter einzeln als P14Zb-Teilpakete integrieren: Claude sowie weitere Modellprovider/OpenAI-Zugangsarten; GitHub über P23, Azure DevOps über P41. Jeder Adapter besitzt eigenes Auth-/Delegationsgate. P37 verwendet dieselben Verbindungen für Sandboxes; P52 ergänzt zentral konfigurierte MCP-Server/Tools mit denselben Secret- und Grant-Bindings, einschließlich OAuth-Erneuerung soweit unterstützt. Das gemeinsame Verbindungsmodell ist verbindlich; nicht jeder Adapter muss zum ersten Teilpaket verfügbar sein.

**Abgrenzung:** Keine Kopie persönlicher Providerprofile oder vollständiger Homes; keine unkoordinierte Verteilung erneuerbarer Login-Caches. Provider-spezifisch unterstützte Delegation nachweisen, statt universelle Token-Weitergabe vorauszusetzen. Fehlende Unterstützung sichtbar sperren und zentral als Handlungsbedarf melden. Kein automatischer Wechsel von Subscription zu API-Abrechnung. Foundry-Login und externe Kontoverbindungen bleiben getrennte Identitäten; zentrale Bedienung führt keine Agent-Turns auf Main ein.

**Gate P14Z je Adapter – Nachweis:** Einmal zentral verbinden, zwei getrennte dauerhafte Testdevices ohne eigene Anmeldung autorisieren; nur freigegebene Bindings nutzbar. Refresh-Rennen, Ablauf, Rotation, Entzug, Offline-Device und Main-/Worker-Neustart prüfen. Widerruf verhindert neue Credential-Ausgabe; bereits ausgegebene Berechtigungen erhalten eine nachgewiesene begrenzte Gültigkeit beziehungsweise wirksamen Upstream-Widerruf, keine Fernlöschungsbehauptung für Offline-Caches. Fremde Instanz/Device/Factory und unzulässiger Scope scheitern; keine Secrets in Logs, Definitionen oder Archiven. Sandbox-Wiederverwendung wird in P37 und MCP-Zugriff in P52 separat abgenommen.

## Factory-MVP · G4

### P18a · Factory und beständiger Auftrag

**Voraussetzungen:** G3.

**Ergebnis und Umfang:** Eigene Automation-Migrationen und Services für Factory, unveränderliche Factory-Version und WorkItem mit Quelle, fachlichem Zustand und Repository-Scope. Archivieren/Wiederherstellen der Factory sperrt/erlaubt neue Starts; aktive Runs brauchen eine separate Steueraktion. Keine historischen Bezüge durch Löschen verlieren.

**Abgrenzung:** Keine Teams, Agentenkoordination oder Git-Synchronisation. Auftragsabschluss ist unabhängig von technischem Run-Erfolg.

**Gate P18a – Nachweis:** Wiederholter Create-Command erzeugt einen Auftrag. Zwei Factories können unabhängig konfiguriert werden; fremde Repository-Bindings scheitern. Archivierung und Neustart erhalten Historie und Start-Sperre.

### P18b · Workflow-Versionen und Automation-Persistenz

**Voraussetzungen:** P18a. Bestehende Verweise auf P18 meinen beide Teilpakete.

**Ergebnis und Umfang:** Unveränderliche Workflow-Versionen, Runs, Commands und Outbox unter Factory/WorkItem; Schema-Validierung für sequenzielle Agent-/Test-/Approval-/Publish-Steps. Factory-Version und Repository-Scope beim Start festhalten.

**Abgrenzung:** Keine graphische Canvas, dynamische Fan-outs oder frei evaluierbare Backend-Skripte.

**Gate P18b – Nachweis:** Version bleibt für gestarteten Run unverändert. Ungültige Referenzen/Zyklen werden abgewiesen; gleiches Command erzeugt einen Run. DB-Rollback hinterlässt weder halben Run noch isolierte Outbox-Aktion; mehrere Revisionen bleiben demselben Auftrag zugeordnet.

### P47 · Kanonische Definition und lokale Validierung

**Voraussetzungen:** P18a/P18b.

**Ergebnis und Umfang:** Versioniertes Factory-Schema für bereits unterstützte Ressourcen, deklarativen Import/Export, lokale Validierung mit Datei-/Feldfehlern und atomare Aktivierung implementieren. Formulare verwenden denselben Validator; Versionen haben Inhalts-Hash und Herkunft. Schema-Erweiterungen für Agenten/Evaluation folgen mit ihren Paketen.

**Abgrenzung:** Noch kein Git-Sync und keine Warp-Formatkompatibilität. Früheres Factory-as-Code-Projekt nur nach tatsächlicher Quellprüfung als Importreferenz behandeln.

**Gate P47 – Nachweis:** Export/Import erhält semantisch dieselbe Konfiguration; ungültige Referenz oder Pfad verlässt die letzte gültige Version unverändert. Konkurrierendes Speichern erkennt Versionskonflikt; aktiver Run bleibt gepinnt; Import kann keine Credentials oder Grants erzeugen.

### P38a · Zentrale Attachment- und Artefaktpersistenz

**Voraussetzungen:** G3, P18a/P18b, P10, P11.

**Ergebnis und Umfang:** Eigenen Main-Service mit dauerhaften Metadaten und persistentem Blob-Verzeichnis bereitstellen. Instanzgebundene Referenzen, fachliche Besitzer auch ohne Workflow-Run, Größen-/Hashprüfung, bestätigtes Chunk-Resume, idempotente Veröffentlichung und autorisiertes Lesen implementieren. Benutzeruploads vor verbindlicher Nachrichtenverwendung zentral bestätigen; Worker erhalten begrenzte Downloads beziehungsweise lokale Arbeitskopien und übertragen eigene Ergebnisartefakte zurück. Web/Windows lesen dieselbe beständige Referenz über Main.

**Abgrenzung:** Browser-Blob-URLs und Worker-Pfade bleiben temporäre Darstellungen. Kein Object-Storage-Kauf, keine automatische Sicherung beliebiger Workspace-Dateien und keine Übernahme persönlicher T3-Daten. Aufbewahrung/Löschung gehören dem Thread/Auftrag, nicht dem Device; Widerruf des Devices entfernt keine bestätigten Benutzerdaten.

**Gate P38a – Nachweis:** Upload in Client A, Originalworker und Client A offline schalten, aus frischem Client B öffnen/herunterladen und Hash vergleichen. Main-Neustart und verlorene Transferantworten erhalten dieselbe Referenz ohne Doppelveröffentlichung. Falscher Besitzer/Instanz, geänderte Bytes und unvollständige Uploads scheitern; HTML/SVG bleibt von der privilegierten UI isoliert. Voller Speicher ergibt keinen erfolgreichen Commit oder kaputte bestätigte Referenz.

### P38b · Fortlaufendes zentrales Thread-Archiv

**Voraussetzungen:** P38a, P09, P16.

**Ergebnis und Umfang:** Für manuelle und Workflow-Threads innerhalb Foundrys Herkunft, geordnete Ereignisse, bestätigten Cursor und referenzierte Anhänge dauerhaft in Main führen. Worker-Ausgang und Main-Eingang wiederholbar abgleichen; bestehende Thread-Ansichten auf einen paginierten, autorisierten Archiv-Leseweg anbinden. Aktive Ausführung bleibt im lokalen T3; die zentrale Kopie weist Vollständigkeit und letzten bestätigten Stand aus. Artefakte werden über P38a referenziert, keine flüchtigen Device-/Browser-URLs gespeichert.

**Abgrenzung:** Keine zweite Orchestrierung, Rohkopie aktiver SQLite-Dateien oder Inventarisierung persönlicher Threads. Kein erfolgreicher Abschluss erforderlicher Ergebnisse mit fehlenden Archivdaten. Offline-Archive bieten keine Live-Terminals; Fortsetzung benötigt einen neuen zulässigen Writer/Workspace. Zentrale Leserechte werden unabhängig von der Erreichbarkeit des ursprünglichen Devices geprüft.

**Gate P38b – Nachweis:** Reconnect ab bestätigtem Cursor, verlorene Acks, Duplikate, Sequenzlücken und Main-/Worker-Neustart prüfen. Nach Worker-Ausfall oder Registrierungsentfernung lesen berechtigte frische Clients bestätigte Nachrichten, Tools, Änderungen, Entscheidungen und Anhänge aus Main; fremde Objektzugriffe bleiben gesperrt. Fehlende Sequenzen/Blobs sind sichtbar unvollständig und verhindern vollständige Ergebnisbestätigung. Manuelle Threads funktionieren ohne künstlichen Workflow-Run.

### P19 · Scheduler und zuverlässiger Step-Dispatch

**Voraussetzungen:** P18, P47, P38a/P38b, P15, P16, P17.

**Ergebnis und Umfang:** Reine Step-Entscheidungen, persistente Claims/Leases und Outbox-Effekte an Worker-Adapter koppeln; erst nächsten Step nach zentral bestätigtem erforderlichem Thread-/Artefaktstand aus P38a/P38b starten.

**Abgrenzung:** Noch keine externen Trigger und keine Parallelität über mehrere Worker.

**Gate P19 – Nachweis:** Crash nach Claim, nach Zustellung und vor Ergebnisbestätigung injizieren. Reconciliation findet vorhandenen Attempt; Testfehler blockiert Folgeaktionen; DB-Lock wird nicht während Netzwerkzugriff gehalten.

### P20 · Run-Steuerung und menschliche Freigabe

**Voraussetzungen:** P19.

**Ergebnis und Umfang:** Pause/Resume/Cancel/Retry und revisionsgebundene Freigaben als Services mit gemeinsamen Web-/Desktop-Commands implementieren.

**Abgrenzung:** Keine automatische Antwort auf Agentenfragen, kein stilles Retry fachlicher Fehler.

**Gate P20 – Nachweis:** Pause verhindert neue Steps; Resume startet nur zulässige. Revision nach Freigabe verändert: Veröffentlichung blockiert. Doppelklick auf Freigabe bleibt idempotent; veraltete UI kann keine frühere Revision freigeben.

### P21 · Manueller Start und Run-Ansicht

**Voraussetzungen:** P20, P47, P38b.

**Ergebnis und Umfang:** Factory-Auswahl und Auftragsdetail, minimalen Formulareditor auf dem kanonischen Schema/Validator aus P47, Veröffentlichung, manuelles Starten und paginierte Run-/Step-Ansicht mit Thread-Links liefern; gleiche Rechte für Settings/Palette/MCP beachten.

**Abgrenzung:** Keine Canvas, kein neuer Provider und keine zweite Transkriptsynchronisation neben P38b.

**Gate P21 – Nachweis:** Replay-Run von Definition bis Ergebnis in Web und Windows bedienen. Browser schließen stoppt Run nicht; erneutes Öffnen zeigt durable Zustände. Bei offline geschaltetem Worker bleiben bestätigte Historie und Anhänge über Main lesbar; fehlende Archivsequenzen werden als unvollständig angezeigt. Umfangreiche Ausgabe wird erst bei Bedarf geladen.

### P49 · Factory-Navigation und persönliche Inbox

**Voraussetzungen:** P21, P47; Git-Anzeige nach P48.

**Ergebnis und Umfang:** Globale/factorybezogene Navigation aus Architekturabschnitt 12, gemeinsame Listenfilter und dauerhafte Inbox-Projektion für Fragen, Antworten, Spec-/PR-Review, Blocker und Fehler. Detailpanel verlinkt WorkItem/Run/T3-Thread; Antworten und Revisionen an P20 anbinden. Gelesen, erledigt und Rückgängig separat führen.

**Abgrenzung:** Nur verfügbare Seiten zeigen. T3-Themes und Komponenten wiederverwenden; keine zweite Chatansicht oder eigene Transkript-Synchronisation neben P38b.

**Gate P49 – Nachweis:** Zwei Clients sehen konsistente Fragen/Freigaben; erledigt erteilt keine Genehmigung. Antwort und veraltete Revision aktualisieren Inbox nach Reconnect. Web/Windows zeigen Listen, Details und Rückweg aus Thread; Palette, Settings und vorhandene Keybindings rufen dieselben Commands auf. Vorher-/Nachher-Captures und Tastaturbedienung prüfen.

### P22 · GitHub-Polling mit persistentem Eingang

**Voraussetzungen:** P18, P19.

**Ergebnis und Umfang:** Ersten GitHub-Issue-Connector mit Opt-in-Label, API-Zugang, Cursor/Overlap, Rate-Limit-Backoff und durablem Inbox-Commit implementieren.

**Abgrenzung:** Kein öffentlicher Webhook erforderlich; keine Rekonstruktion jeder kurzlebigen Eventfolge behaupten.

**Gate P22 – Nachweis:** Mehrfach gelesene Revision und Crash vor Cursorfortschritt erzeugen einen fachlichen Start. Cursor erst nach Inbox-Commit; Bot-Rückmeldungen lösen keine Schleife aus; Rate-Limit verschiebt kontrolliert.

### P23 · Kontrollierter GitHub-Publish-Step

**Voraussetzungen:** P20, P22.

**Ergebnis und Umfang:** Begrenzten Publish-Service mit revisionsgebundener Freigabe, GitHub-App-Zugang, Operationsschlüssel und PR-Reconciliation liefern.

**Abgrenzung:** Kein Merge/Deployment; keine breiten Push-Tokens an Implementierungsagenten.

**Gate P23 – Nachweis:** PR erstellt, Antwort verloren: vorhandenen PR finden statt zweiten erstellen. Unzulässiges Repository, widerrufener Grant oder andere Revision blockieren. Testnachweis gehört genau zum veröffentlichten Commit.

### P24 · Zeitplan-Trigger

**Voraussetzungen:** P18, P19.

**Ergebnis und Umfang:** Zeitplan-Bindings mit Zeitzone, eindeutiger Termin-ID, Nachhol-/Überlappungsregel und Restart-Recovery auf Workflow-Inbox abbilden.

**Abgrenzung:** Bestehende Scheduled Tasks werden weder migriert noch parallel für denselben Workflow aktiviert.

**Gate P24 – Nachweis:** TestClock prüft DST, verpassten Termin, doppelte Claim-Versuche und deaktivierten Trigger. Jede gewählte Nachholregel liefert die definierte begrenzte Zahl von Runs.

## Git-Verwaltung und Dauerbetrieb · G5 / G11

### P48 · Git als Definitions-Owner

**Voraussetzungen:** P47, P22, P23.

**Ergebnis und Umfang:** Das separate Definitions-Repository als verbindlichen Git-Owner an Factory/Pfad/Branch binden, Commit synchronisieren und vollständige Definition validieren. Aktivierte PostgreSQL-Snapshots bleiben unveränderliche Laufzeit-/Historienkopien, keine zweite editierbare Konfigurationsquelle. UI zeigt Quelle, Diff, aktive Revision und Fehler; Git-Felder schreibgeschützt. Wechsel zwischen Foundry- und Git-Verwaltung sowie Aktivierung einer früheren gültigen Revision explizit machen.

**Abgrenzung:** Ein Codehost zuerst: GitHub. Kein eigener gehosteter Git-Dienst und keine zusätzlichen automatischen CI-Jobs; Validierung in bestehende Checks oder lokal integrieren.

**Gate P48 – Nachweis:** Doppelzustellung und Restart aktivieren einen Commit einmal. Ungültiger Commit bleibt inaktiv; ein verspäteter Sync überschreibt keine neuere Auswahl. Owner-Wechsel erkennt Drift; Rollback verändert keinen laufenden Run und umgeht keine aktuellen Grants.

### P26 · Backup und isolierter Restore

**Voraussetzungen:** P02, P18 für die Vorbereitung; integrierte Restore-Abnahme nach G4 und P48.

**Ergebnis und Umfang:** Koordinierte Sicherung von PostgreSQL, Factory-Definitionen samt Herkunft/Git-Owner, Inbox-Zuständen, erforderlichem T3-State, zentralen Thread-Archiven samt Cursorn, referenzierten Attachment-/Artefakt-Blobs und Schlüsseln plus gesperrten Wiederanlauf implementieren; externes Ziel konfigurieren.

**Abgrenzung:** Keine Sicherung gegen die persönliche Live-T3-DB und kein ungeprüftes Zurückspielen in Produktion.

**Gate P26 – Nachweis:** Auf getrenntem Ziel vollständigen Restore ausführen. Entzogene Zugänge werden durch Rotation nicht reaktiviert; Trigger/Publishing bleiben bis Receipt-/PR-Abgleich gesperrt. Gemessene RPO/RTO mit Betreiberziel vergleichen.

### P27 · Kontrollierter Rollout und Betriebsgrenzen

**Voraussetzungen:** G4, P48, P26.

**Ergebnis und Umfang:** Einzelreplik-Rollout mit Drain/Migration/Readiness, Ressourcen-/Stream-/Disklimits und Mindestalarmierung dokumentieren und technisch anbinden.

**Abgrenzung:** Keine neue automatische Release-Pipeline, HA oder Scale-to-zero.

**Gate P27 – Nachweis:** Isoliertes Upgrade mit laufendem Replay und inkompatiblem Schema prüfen; zulässigen Rollback oder Restore belegen. Main-Neustart, voller Artefaktspeicher und DB-Ausfall führen zu sichtbarem begrenztem Fehler, keinem zweiten Writer.

## Zusammenarbeit und wiederverwendbare Agenten · G6 / G12

### P51 · Auftrag in T3 übernehmen und zurückgeben

**Voraussetzungen:** P17, P20, P49; Sandbox-Handoff zusätzlich P38c/P39.

**Ergebnis und Umfang:** Übernahme-/Rückgabe-Service mit Writer-Übergabe, explizitem Alternativbranch, Kontext-/Revisionsmanifest und beidseitigen Links. Vorhandenen Thread/Workspace verwenden oder aus gesichertem Stand einen neuen anlegen. Rückgabe setzt denselben Auftrag mit neuer Revision fort.

**Abgrenzung:** Kein allgemeiner Session-Umzug zwischen Providern/Maschinen und kein Überschreiben uncommitteter Benutzerarbeit.

**Gate P51 – Nachweis:** Gleichzeitige Übernahme/Dispatch und verlorenes Ack erzeugen keinen zweiten Writer. Rückgabe ist idempotent, prüft Basisrevision und entwertet alte Freigaben. Nach Ressourcenverlust nur gesicherten Stand öffnen; fehlendes Archiv sichtbar blockieren.

### P58 · Externe API und Factory-MCP

**Voraussetzungen:** P47, P49, P51.

**Ergebnis und Umfang:** P58a liefert dünne versionierte HTTP-Endpunkte und maschinenlesbaren API-Vertrag; P58b bindet MCP für Factory-/Auftragssuche, Start/Steuerung, Übergabe und Definitionsvalidierung an dieselben Services. Typisierte Client-Nutzung und minimale Beispiele statt mehrerer eigener SDK-Runtimes.

**Abgrenzung:** UI-interne RPCs bleiben erhalten. Maschinenzugang braucht eigene begrenzte Credentials; kein interaktives Access-Cookie in CI. Python-/TypeScript-SDK-Pakete erst bei konkretem Bedarf aus dem Vertrag ableiten.

**Gate P58a/P58b – Nachweis:** UI/API/MCP mit gleichem Grant haben gleiche erlaubte Wirkung. Lesen, Steuern, Konfiguration und Freigabe bleiben getrennt; unbekannte Versionen, fremde Factory und widerrufene Credentials scheitern. Command-Retry bleibt idempotent. MCP-Texte erhalten Evals.

### P28 · Versionierter Agent- und Skill-Katalog

**Voraussetzungen:** G5, P47.

**Ergebnis und Umfang:** Gepinnte Agent-/Skill-Versionen im kanonischen Definitionsformat, Hashprüfung und effektiven Run-Snapshot hinzufügen; zunächst vorhandene Providerfähigkeiten nutzen.

**Abgrenzung:** Keine globale mutable memory.md oder Ausweitung von Rechten durch Prompttexte.

**Gate P28 – Nachweis:** Katalogänderung verändert gestarteten Run nicht; fehlender zwingender Skill blockiert. Materialisierung überschreibt keine Repo-Instruktionen. Modellseitige Texte erhalten passende Evals gemäß evals/README.md.

### P52 · Agentenressourcen und Ausführungseinstellungen

**Voraussetzungen:** P28, P49; zentrale MCP-/Credential-Bindings benötigen P14Z, Pool-/Sandbox-Einstellungen erst nach P32/P34.

**Ergebnis und Umfang:** P52a liefert das Agentendetail mit Instruktionen, Automationen, Version und Einstellungen; globale MCP-/Secret-/Connector-Ressourcen an Factory und Rolle binden. Provider, Modell und unterstützte Optionen aus Worker-Capabilities beziehen; wirksame Defaults/Overrides anzeigen. P52b ergänzt deklarative Modell-Routingregeln nach Aufgabenklasse und ausdrücklich erlaubter Kandidatenliste; die aufgelöste Wahl samt Regelversion wird vor Dispatch festgehalten.

**Abgrenzung:** Keine Secrets in Definitionsdateien und kein pauschales Fähigkeitenversprechen für alle Provider.

**Gate P52a/P52b – Nachweis:** Fehlendes Recht und zwingend fehlende Fähigkeit blockieren verständlich. Widerruf wirkt auch nach einem gespeicherten Snapshot. Für Codex, Claude, Cursor, Grok, OpenCode und Antigravity je eine ausdrückliche Capability-Entscheidung dokumentieren; unterstützte Adapter gezielt prüfen, übrige deaktiviert lassen. Kein stiller Provider-/Kontowechsel. Routing ohne passenden autorisierten Kandidaten blockiert; ein Retry ändert die gespeicherte Auswahl nicht.

### P29 · Fan-out/Join und begrenzte Reparaturschleifen

**Voraussetzungen:** P28.

**Ergebnis und Umfang:** Stabile Element-IDs, konfigurierbare Join-/Fehlerregeln, Parallelitätsgrenzen und explizites Iterationsbudget einführen.

**Abgrenzung:** Keine freien rekursiven Swarms oder unbeschränkten technischen Retries.

**Gate P29 – Nachweis:** Teilfehler/Retry erfüllen exakt die gewählte Join-Regel. Gleiches Element wird nicht dupliziert; Reparaturschleife stoppt am Limit; Ausfall während Fan-out verliert keinen Attempt.

### P50 · Optionaler Koordinator als Agentenrolle

**Voraussetzungen:** P28, P29, P49.

**Ergebnis und Umfang:** Koordinator-Dialog am Auftrag, strukturierte Plan-/Revisionsvorschläge und validierte Auswahl zulässiger Stufen. Service setzt Budget, Rechte, Freigaben und begrenzte Reparatur durch; Koordinator läuft über den vorhandenen Worker-Adapter.

**Abgrenzung:** Kein Agent als dauerhafter Scheduler, kein unbeschränkter dynamischer Graph und kein Agent auf Main.

**Gate P50 – Nachweis:** Eval für unzulässiges Repo, übersprungene Pflichtfreigabe und widersprüchliche Rückmeldung. Provider-Ausfall/Main-Restart verliert keinen angenommenen Plan; doppelter Vorschlag erzeugt keine doppelten Steps. Statischer Workflow funktioniert weiter ohne Koordinator.

### P53 · Vorlagen für Triage und PR-Review

**Voraussetzungen:** P28, P29, P22, P23, P49.

**Ergebnis und Umfang:** Zwei einzeln abnehmbare Vorlagen P53a (Issue-Triage) und P53b (PR-Review) ergänzen den Issue-to-PR-MVP. GitHub-Eingang und Rückmeldung am Ursprungsobjekt hinzufügen; Kommentare/Folgeereignisse dem vorhandenen Auftrag zuordnen.

**Abgrenzung:** Kein automatisches Mergen. Review zunächst für autorisierten eigenen Code; fremden Code nicht auf dem Host-Worker ausführen.

**Gate P53a/P53b – Nachweis:** Triage darf bewusst ohne Codeänderung enden. Neuer PR-Head verwirft veraltetes Review; doppelte Kommentare/Events erzeugen keine Rückkopplung. Findings führen zur passenden begrenzten Revision und nicht zu einem unabhängigen Auftrag. Modelltexte erhalten Evals.

### P30 · Mehrere Repositories pro Auftrag

**Voraussetzungen:** P29, P17.

**Ergebnis und Umfang:** Den in P18a eingeführten Ticket-/Auftragsbezug auf eine gepinnte Repository-Menge mit getrennten Workspaces, Ergebnissen und PRs pro Repository erweitern.

**Abgrenzung:** Zunächst ein Repository pro Thread; kein atomarer Cross-Repo-Push.

**Gate P30 – Nachweis:** Zehn Analysen mit begrenzter Parallelität, danach nur betroffene Repositories implementieren. Teilveröffentlichung ist sichtbar; Retry erzeugt keine doppelten PRs und überschreibt keine fremden Branches.

### P31 · Mehrere Repositories in einem Agent-Step

**Voraussetzungen:** P30.

**Ergebnis und Umfang:** Workspace-Bundle mit Hauptprojekt, zusätzlichen Checkouts sowie aggregiertem Diff-/Checkpoint-/Ergebnismanifest ergänzen.

**Abgrenzung:** Nur wenn realer Ablauf mehrere Repositories in einem Thread verlangt; sonst G6 ohne dieses Paket abschließen und Fähigkeit deaktiviert lassen.

**Gate P31 – Nachweis:** Änderungen und Basis-/Ergebnisobjekte aller Repositories sind im Manifest nachgewiesen. Fehlender Checkpoint eines Repos blockiert vollständigen Erfolg; Resume erhält dieselben Zuordnungen.

## Messen und verbessern · G13

### P54 · Nachvollziehbare Betriebs- und Produktmetriken

**Voraussetzungen:** G5, P49, P23.

**Ergebnis und Umfang:** P54a erfasst versionierte Nutzungs-/PR-Ereignisse, Zuordnungsregeln und verfügbare Limits; P54b liefert darauf das Factory-Dashboard mit Zeitraum, Qualitäts-/PR-Aktivität, Zeitanteilen, Autonomie und ausgewiesenen Kostenschätzungen. Summen sind bis zu ihren Runs nachvollziehbar.

**Abgrenzung:** Keine erfundenen Subscription-Einzelpreise oder Gleichsetzung von Schätzung und Rechnung. Keine zusätzliche Analytics-Infrastruktur.

**Gate P54a/P54b – Nachweis:** Parent/Child und mehrere PRs doppelt zählen verhindern; verspätete Ereignisse und Reconciliation korrigieren Aggregate. Fehlender Preis bleibt unbekannt. Abbruch, Queue-/Review-Wartezeit und Zeitzonen in Fixtures prüfen; Dashboard über begrenzte Abfragen und sichtbare Subscriptions bedienen.

### P55 · Versionierte Scorers und Bewertungshistorie

**Voraussetzungen:** P28, P47, P54a.

**Ergebnis und Umfang:** Kriterien, Judge-Konfiguration, Klassifikationen, Schwelle und Sampling versionieren. Nach abgeschlossenem Run oder manuell eine begrenzte Bewertung auf eingefrorener Evidence ausführen; Ergebnisse auf Scorer-Seite und am Run zeigen.

**Abgrenzung:** Bewertungsfehler ist kein bestandenes Ergebnis. LLM-Bewertung ersetzt keine Test-Exitcodes oder Freigaben.

**Gate P55 – Nachweis:** Sampling/Retry dupliziert keine Bewertung; Neubewertung erhält die alte Historie. Gepinnte Kriterien und Input bleiben nachvollziehbar; fehlende Evidence führt zu nicht bewertbar. Judge-Verbrauch zählt zum Budget. Evals für die Modellinstruktionen.

### P56 · Wiederholbare Benchmarks

**Voraussetzungen:** P55, P17; für Sandbox-Trials zusätzlich G8.

**Ergebnis und Umfang:** Suites aus fertigen Runs oder manuellen Aufgaben, gepinnte Repo-Ausgangsstände, Kriterien und Konfigurationsvarianten definieren. Trials/Wiederholungen mit Grenzen starten und stoppen; Qualitäts-, Zeit- und Kostenvergleich mit Drill-down bereitstellen.

**Abgrenzung:** Vor G8 nur autorisierter eigener Code in getrennten verwalteten Host-Workspaces; keine Sandbox-Zusage durch Worktrees. Keine produktiven Publish-Aktionen oder universelle Modellrangliste. Referenzdaten mit Secrets/privaten Ticketinhalten nicht ungeprüft übernehmen.

**Gate P56 – Nachweis:** Jede Variante startet am selben Stand; Trials schreiben getrennt und verändern keine Live-Factory. Abbruch und unbewertbare Trials erscheinen vollständig. Kosten enthalten Judges; Übernahme einer Empfehlung erzeugt eine neue geprüfte Definition.

### P57 · Belegte Verbesserungsvorschläge

**Voraussetzungen:** P48, P55, P56, P23.

**Ergebnis und Umfang:** Explizit aktivierbare, begrenzte Fehlerauswertung erzeugt einen Auftrag und Vorschlags-PR für Code, Prompts, Skills oder Konfiguration. Fehlende/erledigte Fehlergruppen nicht erneut verarbeiten; manuell auslösbar und deaktivierbar.

**Abgrenzung:** Keine autonome Aktivierung, kein Auto-Merge und keine Budget-/Rechteänderung durch den Verbesserungsagenten.

**Gate P57 – Nachweis:** Wiederholte Auswertung erzeugt keinen zweiten Vorschlag. PR verlinkt Fehler, Definition und Regressionsevidence; Ablehnung und neue Revision bleiben nachvollziehbar. Produktivversion ändert sich erst über P48 und menschliche Entscheidung.

## Mehrere Worker und Sandboxes · G7 / G8

### P32 · Kapazitäten und explizite Zielauswahl

**Voraussetzungen:** G5, P11, P16, P14Za für zentral autorisierte Worker.

**Ergebnis und Umfang:** Atomare Worker-Reservierungen, provider-/kontobezogene Limits, feste Ziele und freigegebene Pools sowie draining bereitstellen.

**Abgrenzung:** Kein stiller Wechsel von Konto, Provider oder isoliertem auf unisoliertes Ziel.

**Gate P32 – Nachweis:** Zwei konkurrierende Claims überschreiten Kapazität nicht. Festes Offline-Ziel wartet; Pool nimmt nur passende erlaubte Geräte. Stale Heartbeat und Grant-Widerruf schließen neue Reservierung aus.

### P33 · Mehrere Worker und Recovery bei Partitionen

**Voraussetzungen:** P32.

**Ergebnis und Umfang:** Mehrere dauerhafte Ziele mit Gateway-/Dispatch-Reconciliation und nachvollziehbarer Gerätezuordnung integrieren.

**Abgrenzung:** Keine transparente Live-Migration aktiver Agenten.

**Gate P33 – Nachweis:** Netzpartition während Implementierung und spätes Ergebnis einer alten Generation provozieren: kein konkurrierender Writer, keine Ergebnisüberschreibung. Browser- und Main-Neustart behalten Zuordnung; kontoweite Limits wirken geräteübergreifend.

### P34 · Sandbox-Profile und Allocation-Service

**Voraussetzungen:** G7.

**Ergebnis und Umfang:** Versionierte Profile, Benutzer-/Run-Owner, Quoten, Zustände und idempotente Provisionierungsaufträge einführen; API auch ohne Workflow anbieten.

**Abgrenzung:** Noch kein tatsächlicher Containerstart, keine Mehrmandanten-Garantie.

**Gate P34 – Nachweis:** Doppelte Anfrage/Cancel erzeugt eine Allocation; Budget-/Capability-Verletzung scheitert vor Provisionierung. Ein Benutzerauftrag braucht keinen künstlichen Workflow-Run.

### P35 · Linux-OCI-Supervisor

**Voraussetzungen:** P34.

**Ergebnis und Umfang:** Einen Container-Adapter mit Besitzlabels, Digest-Pinning, lokalen Ressourcenlimits, Cancel und Reconciliation implementieren. Supervisor außerhalb Sandbox mit eng begrenztem Provisionierungsvertrag.

**Abgrenzung:** Kein Docker-Socket, privilegierter Container oder beliebiger Host-Mount in der Sandbox; nur vertrauenswürdiger Code.

**Gate P35 – Nachweis:** Crash nach Containerstart vor Antwort: genau eine eigene Ressource wiederfinden. Fremde Container nie aufräumen. Abbruch in jeder Phase beendet Ressourcen; überschrittene Profile/Rechte werden abgewiesen.

### P36 · Setup-Profil und Sandbox-Enrollment

**Voraussetzungen:** P35, P06, P07.

**Ergebnis und Umfang:** Sandbox-Environment registrieren, Bootstrap entfernen, gepinnte Checkouts/Tools/Skills und Setup-Befehle materialisieren; readiness erst nach erfolgreichem Setup.

**Abgrenzung:** Keine Toolinstallation mit Admin-Secrets aus Main und kein stilles Image-Upgrade.

**Gate P36 – Nachweis:** Fehlendes Tool, falsche Architektur, Setup-Fehler und Hashabweichung ergeben erklärten Nicht-ready-Zustand. Setup sieht weder Enrollment-Einmaltoken noch Host-/Main-Adminzugang; wiederholte Provisionierung bleibt konsistent.

### P37 · Unterstützter Codex-Credential-Bootstrap für Sandboxes

**Voraussetzungen:** P36, P14, P14Za.

**Ergebnis und Umfang:** Genau einen verifizierten Provider-Pfad mit Kontobindung, Refresh-Owner, Ablauf und Widerruf integrieren; capability-gesteuerte Freigabe.

**Abgrenzung:** Kein Klonen vollständiger Benutzer-Homes oder erneuerbarer Login-Caches in einen Pool; andere Provider bleiben separat zu prüfen.

**Gate P37 – Nachweis:** Zwei Sandboxes erzeugen keinen Refresh-Konflikt. Abgelaufener/entzogener Zugang blockiert weitere Nutzung; Logs/Artefakte enthalten keine Tokens. Fehlt unterstützter Pfad, bleibt Codex-Sandboxfähigkeit aus und G8 für echte Codex-Nutzung offen.

### P38c · Sandbox-Abschluss und Cleanup

**Voraussetzungen:** P36, P38a/P38b.

**Ergebnis und Umfang:** Vorhandene zentrale Thread-/Artefaktpersistenz um finalen Abschlusscursor, erforderliche Git-Objekte und Abschlussmanifest für Sandbox-Löschung ergänzen; TTL, Reaper und Notfallbereinigung implementieren. Kein zweiter Archivspeicher.

**Abgrenzung:** Ein gespeicherter SHA oder leeres Thread-Stub gilt nicht als vollständiges Archiv.

**Gate P38c – Nachweis:** Disconnect während Abschlussübertragung setzt ohne Lücke/Duplikat fort. Reguläres Löschen wartet auf bestätigte Thread-Sequenz, sämtliche erforderlichen Blobs/Git-Objekte und Manifest. Sandbox einschließlich lokaler Volumes vollständig löschen; frische Web-/Windows-Clients öffnen Historie und Anhänge ausschließlich aus Main und setzen Arbeit auf einem neuen Device fort. Erzwungener Verlust markiert unvollständig; fremde Ressourcen bleiben unberührt; wiederholtes Cleanup ist idempotent.

### P39 · Interaktive Sandbox im Client

**Voraussetzungen:** P37, P38c, P12.

**Ergebnis und Umfang:** Anfordern, Setupstatus, Öffnen, Verlängern und Löschen einer Benutzer-Sandbox sowie anschließende Archivansicht integrieren.

**Abgrenzung:** Keine versteckten Workflow-Runs, keine automatisch dauerhafte Sandbox.

**Gate P39 – Nachweis:** In Web/Windows Anfrage bis Thread und Archiv bedienen. Quota/fehlender Provider nachvollziehbar; Löschung schließt Livezugriff und öffnet Archiv. Fortsetzung erzeugt neue Umgebung aus gesichertem Stand.

### P40 · Sandbox-Ausführung im Workflow

**Voraussetzungen:** P34, P37, P38c, P19.

**Ergebnis und Umfang:** Allocation an Attempt oder Run binden, Reservierung/Provisionierung/Wartezustände und Abbruch in Dispatch einbeziehen.

**Abgrenzung:** Manuelle und automatische Nutzung teilen denselben Service; kein zweiter Sandbox-Codepfad.

**Gate P40 – Nachweis:** Cancel während Setup, Main-Ausfall und Retry finden dieselbe Allocation. Ergebnisfinalisierung wartet auf nötige Artefakte; kein Publishing mit alter Lease; Sandbox-Quota zählt Benutzer- und Workflow-Aufträge zusammen.

## Optionale Eingänge, Memory und Vorlagen · G9 / G14

### P25 · Signierter GitHub-Webhook als optionaler Eingang

**Voraussetzungen:** P22, P23.

**Ergebnis und Umfang:** Eng begrenzten Webhook-Handler mit Raw-Body-HMAC, Installation/Repo-Prüfung und gemeinsamer fachlicher Deduplizierung ergänzen; genaue Access-Routenregel im Runbook beschreiben.

**Abgrenzung:** Keine globale Access-Ausnahme; erst nach operatorseitiger Konfiguration aktivieren.

**Gate P25 – Nachweis:** Gültiger Event wird erst nach Commit bestätigt; falsche Signatur/Installation scheitert. Webhook plus Polling erzeugen einen Start. DB-Ausfall liefert Fehler; UI/API/Gateway behalten ihre Foundry-Autorisierung und im Access-Betrieb zusätzlich den Access-Schutz.

### P41 · Azure-DevOps-Connector

**Voraussetzungen:** G5.

**Ergebnis und Umfang:** Einen priorisierten Work-Item-zu-Workflow-Pfad mit autorisierter Anwendungsidentität, Event-/Polling-Normalisierung und Deduplizierung ergänzen.

**Abgrenzung:** Keine implizite Gleichsetzung von Azure- und GitHub-Tokenrechten; kein generischer Integrationsbaukasten.

**Gate P41 – Nachweis:** Falsches Projekt/fehlendes Recht wird abgewiesen; doppelte/verspätete Zustellungen erzeugen keinen zweiten fachlichen Run. Abgelaufene Anmeldung wird als wartend sichtbar; Connector-Schleifen ausgeschlossen.

### P42 · Jira/JSM-Connector

**Voraussetzungen:** G5.

**Ergebnis und Umfang:** Genau Jira Cloud oder Data Center für einen konkreten Bedarf auswählen; Request-Type/Projektbezug, autorisiertes Nachladen und Webhook-/Polling-Lebenszyklus implementieren.

**Abgrenzung:** Nicht beide Hostingvarianten in einem PR, kein künstliches Source-Control-Interface für Tickets.

**Gate P42 – Nachweis:** Unzulässiges Service-Projekt scheitert; fehlende JSM-Felder werden nur berechtigt geladen. Wiederzustellung/Erneuerung verlieren keinen akzeptierten Auftrag und duplizieren ihn nicht.

### P43 · Belegbares Memory mit Aufbewahrung

**Voraussetzungen:** P28, G5.

**Ergebnis und Umfang:** Versionierte Repository-/Workflow-Einträge mit Herkunft, Scope, Freigabe und Löschung sowie einfacher Suche ergänzen.

**Abgrenzung:** Keine Vektordatenbank als Voraussetzung und kein automatisch globales Wissen aus privaten Tickets.

**Gate P43 – Nachweis:** Konkurrierende Updates erkennen Konflikt; alte/abgelaufene Einträge sind gekennzeichnet. Scope-Prüfung verhindert falsche Freigabe; Löschen/Aufbewahrung erfassen referenzierte sensible Inhalte nach festgelegter Policy.

### P59 · Zusätzliche Arbeitsquellen

**Voraussetzungen:** G5, P49; P59a zusätzlich P25, Git-Schreibaktionen zusätzlich P23-Prinzipien.

**Ergebnis und Umfang:** Getrennte PRs: **P59a** generische signierte Webhooks mit Payload-Filtern und Zustelllog, **P59b** GitLab, **P59c** Linear, **P59d** Slack, **P59e** Microsoft Teams. P41/P42 bleiben Owner für Azure DevOps und Jira/JSM. Jeder Connector normalisiert Auftrag, Rückfragen und Ergebnislinks am Ursprungsort; Verbindung, Widerruf und Fehlerzustand werden sichtbar.

**Abgrenzung:** Kein Sammel-Connector-PR und keine Aktivierung ohne gewählten Account/Rechte. Filter begrenzen Trigger, nicht Ressourcenrechte.

**Gate je Teilpaket – Nachweis:** Authentifizierung, doppelte/verspätete Zustellung, Identitätszuordnung, Bot-Schleifen, Tokenablauf und Rate Limits mit echten Providergrenzen prüfen. Eine Antwort setzt den passenden Auftrag fort. Öffentliche Route umgeht weder Foundry-Rechte noch die Authentifizierung der Zustellung.

### P60 · Browser-Verifikation und Incident-Vorlagen

**Voraussetzungen:** P28, P29, P49; **P60a** zusätzlich G8 und geprüfte Preview-Isolation; **P60b** zusätzlich den gewählten Monitoring-Eingang aus P59a/P58a.

**Ergebnis und Umfang:** **P60a** lässt einen Verifier einen isolierten Teststand bedienen und revisionsgebundene Screenshots/Testberichte als Artefakte liefern. **P60b** korreliert Betriebsalarm, Diagnose und Fix-Vorschlag in einem Auftrag. Getrennte Vorlagen/PRs mit eigenen Capability-Nachweisen.

**Abgrenzung:** Keine Browserinhalte unter privilegierter Main-Origin, keine Produktionscredentials im Testbrowser, kein automatischer Produktions-Deploy und keine Mobile-Abnahme.

**Gate P60a/P60b – Nachweis:** Browserfehler/fehlende Evidence blockieren Verifikation; richtige Build-Revision und Artefaktzugriff nach Cleanup belegen. Wiederholter Alarm erzeugt keine parallelen Reparaturen; Diagnose ohne Fix bleibt ein zulässiges Ergebnis. Reale Browserabnahme und Instruktions-Evals ergänzen Replay-Tests.

## Optionale Identität und Hosting · G10

### P44 · Optionaler Clerk/OIDC-Identitätsadapter

**Voraussetzungen:** G5.

**Ergebnis und Umfang:** Einen tatsächlich benötigten IdP mit Zuordnung zur bestehenden internen Benutzeridentität integrieren; Account-Link/Unlink und Recovery explizit behandeln.

**Abgrenzung:** Keine Teams/Rollen oder Mehrmandantenfähigkeit als Nebenwirkung; kein neuer Default ohne Betreiberentscheidung.

**Gate P44 – Nachweis:** Login/Logout und falsche Audience/Subject prüfen; Account-Wechsel übernimmt keine fremden Devices. Migration erhält Besitz und Widerruf; Rückweg zum vorherigen Zugang wurde getestet.

### P45 · Teamzugriff auf Device-Gruppen

**Voraussetzungen:** P44.

**Ergebnis und Umfang:** Für einen konkreten Mehrbenutzerbedarf Mitgliedschaften und Device-Gruppen-Grants an denselben Autorisierungspunkt anbinden; Audit und Migration vom Einzelbetreiber ergänzen.

**Abgrenzung:** Nur Device-Gruppen in diesem Paket. Andere zentrale Objekttypen bleiben bis eigener Rechte-PRs owner-only; kein allgemeines Enterprise-Release.

**Gate P45 – Nachweis:** Zwei reale Testidentitäten: verbotene Devices weder auflisten noch per erratener ID öffnen oder über Automation/Sandbox erreichen. Gruppenentzug beendet betroffene Sessions; bestehender Betreiber verliert nicht versehentlich Recovery-Zugang.

### P46 · Portabilitätsnachweis auf einem zweiten Container-Host

**Voraussetzungen:** G5.

**Ergebnis und Umfang:** Für eine konkret gewählte Hostingplattform Single-Replik-Deployment mit externer DB, persistentem State/Artefakten, Secrets und Ingress validieren; vorhandenen Aufbau konfigurierbar halten.

**Abgrenzung:** Keine HA oder horizontale Skalierung in diesem PR. Scale-to-zero und gemeinsam von Replikaten beschriebene SQLite bleiben ausgeschlossen.

**Gate P46 – Nachweis:** Umzug auf isolierte Instanz mit Restore/Identitätsbindung, WebSocket-Reconnect, Shutdown/Drain und Ausfallprobe nachweisen. Hostpfade/Secrets sind nicht ins Image eingebrannt; ursprüngliche Instanz wird nicht parallel mit derselben aktiven Identität gestartet.

## Übergeordnete Integrationsabnahmen und Handoffs

Die folgenden Prüfungen testen das Zusammenspiel, das einzelne Pakettests nicht beweisen. Sie werden einmal auf dem integrierten Stand des jeweiligen Gates ausgeführt und nur bei Änderungen, Fehlern oder relevanten Upstream-Updates wiederholt. Nachweise liegen im abschließenden PR/Issue mit Links auf die Paket-PRs. Sie werden nicht als dauerhaftes Testergebnis in diesen Plan geschrieben.

| Gate | Integrierter Nachweis                                                                                                                                                                                                                                                                                                                                                                                                                                      | Handoff Agent → Betreiber → Agent                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | Zwei frische Profile (Web/Windows): URL, Anmeldung, Main-Identität, HTTP/WS, Tokenablauf, Neustart, Logout und fremde Instanz; separat für G1-Access und G1-Nativ. Keine kopierten Cookies oder geteilten Client-Secrets                                                                                                                                                                                                                                   | Agent liefert Build und reproduzierbare Bedienfolge; Betreiber stellt Windows-Testhost und führt den Login des jeweiligen Modus aus; Agent prüft Transport/Sessions. Fehlender Host oder fehlerhafter Login lässt dessen G1-Abnahme offen      |
| G2   | Zwei Clients und ein Device ohne eingehend erreichbaren Port: Discovery, Replay-Thread, Terminal, Datei, Diff, Attachment. Main-Neustart und Session-Ablauf, im Access-Modus zusätzlich Access-Ablauf einbeziehen; Grant im laufenden Stream entziehen; falsches Device und Proxy-Ziel abweisen                                                                                                                                                            | Agent stellt isolierte Umgebung; Betreiber richtet im Access-Modus die dokumentierte Access-Machine-Policy ein und liefert das Secret sicher; Agent prüft erlaubten und verweigerten Zugriff. Kein Betreiber-Token wird in Artefakte eingebaut |
| G3   | Worker-Dienst neu starten, Providerstatus prüfen, Launch-Antwort verlieren, Checkpoint verzögern, Cancel/Netzpartition und Workspace-Konflikt auslösen. Genau ein aktiver Attempt; kein fremder Checkout betroffen                                                                                                                                                                                                                                         | Agent bereitet eigenen Dienst und Replay-Nachweis vor; Betreiber entscheidet Dienstkonto/Workspace-Wurzeln und meldet Provider an; Agent prüft Status. Ein echter kostenpflichtiger Turn erfolgt nur mit eigener Freigabe                      |
| G4   | Factory-Definition importieren, im Formular mit demselben Validator bearbeiten und per Inbox steuern. Freigegebenes GitHub-Testissue über Polling: Analyse → Änderung → Test → Freigabe → PR. Inbox-/Dispatch-/Publish-Antworten gezielt verlieren, Browser schließen und Main neu starten. Genau ein fachlicher Run/PR, kein Publishing bei fehlerhaftem Test oder geänderter Revision; bestätigte Threads und Anhänge nach Worker-Ausfall aus Main lesen | Agent liefert Workflow und GitHub-App-Rechtebedarf; Betreiber wählt Repo/Label und richtet Zugang ein; Agent führt zunächst Replay/Connector-Fixtures aus und bereitet konkrete Veröffentlichung zur Freigabe vor                              |
| G5   | Backup auf externes Ziel einschließlich Definitionen, Git-Owner und Inbox; isolierter Restore, Abgleich bereits veröffentlichter PRs, Zugangswiderruf nach Restore und Schema-Upgrade mit Drain. Datenintegrität sowie gemessene Wiederherstellungszeiten dokumentieren                                                                                                                                                                                    | Agent liefert Backup-/Restore-Verfahren; Betreiber entscheidet Speicher, RPO/RTO und Aufbewahrung; Agent probt Wiederherstellung getrennt vom Live-System. Produktive Migration bleibt ein eigener konkreter Handoff                           |
| G6   | Auftrag über mehrere Repositories mit gepinnten Versionen, begrenzter Parallelität, Teilfehler und Retry. Pro Repo nachvollziehbare Revision/PR; bei P31 Diff und Checkpoint aller Repos prüfen                                                                                                                                                                                                                                                            | Agent bereitet Fixtures und Bericht vor; Betreiber legt reale Repo-Menge und Publish-Rechte fest, bevor diese aktiviert werden                                                                                                                 |
| G7   | Zwei Worker, kontoweites Limit, festes Offline-Ziel, Pool-Auswahl und Netzpartition während Schreibarbeit. Ein verspätetes altes Ergebnis darf aktuelle Arbeit nicht überschreiben                                                                                                                                                                                                                                                                         | Agent zeigt Kapazitäts-/Fehlernachweis; Betreiber bestimmt erlaubte Devices, Providerkonten und Ressourcenlimits; Agent prüft tatsächliche Durchsetzung                                                                                        |
| G8   | Dieselbe Sandbox-Profilversion einmal interaktiv und einmal per Workflow nutzen. Abbruch bei Provisionierung/Setup/Auth/Archivierung, Supervisor-Restart, Quota, TTL-Verlängerung, vollständige Löschung samt lokaler Volumes, geräteunabhängiges Lesen von Thread/Anhängen und Fortsetzung aus Archiv prüfen                                                                                                                                              | Agent liefert Profil/Supervisor und Replay-Nachweis; Betreiber designiert Sandbox-Host sowie Provider-Zugang; Agent validiert Isolation und Auth. Nicht unterstützter Provider bleibt deaktiviert, kein stiller API-Fallback                   |
| G9   | Für jeden aktivierten Connector echte Auth-/Payload-Grenze plus deterministische Doppelzustellung; bei Memory Scope, Herkunft, Konflikt und Löschung                                                                                                                                                                                                                                                                                                       | Agent benennt minimale Rechte und Fixture-Ergebnisse; Betreiber stellt genau den ausgewählten Connector bereit; Agent bestätigt oder blockiert dessen Aktivierung separat                                                                      |
| G10  | P44: bestehende Besitzerbindung nach IdP-Wechsel. P45: zweite Testidentität und negative Device-/Automation-/Sandbox-Zugriffsmatrix. P46: Restore/Ingress/WebSockets auf konkretem Hostingziel                                                                                                                                                                                                                                                             | Betreiber wählt zuerst benötigten Ausbau; Agent spezifiziert dessen eigene Abnahme. Ein Erfolg bei P44 gibt weder Teams noch neues Hosting automatisch frei                                                                                    |

**G11 wird zusammen mit G5 abgenommen**, sobald P47–P49 integriert sind; es wartet nicht auf G6–G10. Für **G11** führt der integrierte Nachweis von einer importierten Definition über Git-Änderung und ungültigen Folgecommit bis zu einem Auftrag mit Inbox-Entscheidung; alte Runs behalten ihre Version. **G12** weist denselben Auftrag von Koordinator über lokale T3-Übernahme und Rückgabe bis zum geprüften PR über UI und MCP nach, einschließlich widerrufener Rechte. **G13** reproduziert einen Fehler als Benchmark, erzeugt einen belegten Verbesserungsvorschlag und übernimmt ihn erst nach Prüfung; fehlende Kostendaten bleiben sichtbar. **G14** wird je Connector/Vorlage separat freigegeben. Der Agent liefert isolierte Fixtures, Builds und Evidence; der Betreiber stellt ausschließlich die für das jeweilige Gate benötigten Accounts/Devices bereit. Keine neuen pauschalen Zugangsvoraussetzungen für frühere Gates.

## Evidence und Fehlerbehandlung

Der Abschluss eines Gates dokumentiert: zugehörige Paket-PRs, geprüfte SHAs/Images, Umgebung und Protokollversionen, positive und negative Fälle, Ergebnis sowie offene Grenzen. Ein Screenshot beweist UI-Verhalten; Crash-Recovery, Autorisierung oder Deduplizierung benötigen zusätzlich Test-/Runtime-Nachweise. Keine Claims über Cloudflare/Windows/Provider-Kompatibilität ausschließlich aus Mocks ableiten.

Bei Fehlschlag wird das Problem dem verursachenden Paket oder einem eng begrenzten Folge-PR zugeordnet. Nach Fix werden das betroffene Paketgate und die davon berührten Integrationsfälle erneut geprüft. Bereits bestandene, unabhängige Gates werden nicht ohne Anlass komplett wiederholt. Kompatibilitätsänderungen im Auth-/Transportvertrag können G1/G2 ausdrücklich wieder öffnen; der Änderungs-PR nennt dies.

Vor der Umsetzung eines späten Pakets wird dessen Umfang gegen aktuelle Contracts und reale Anforderungen geschärft. Die Reihenfolge darf nur mit dokumentierten Auswirkungen auf Abhängigkeiten geändert werden. HA, Multi-Tenant-Hosting, vollständige Teamrechte auf alle Ressourcen, Mobile und zusätzliche Sandbox-Backends haben hier bewusst noch keine scheinbar fertigen PR-Pakete: Sie benötigen nach konkretem Bedarf einen eigenen Entwurf samt Gates. P45 allein erlaubt höchstens den beschriebenen begrenzten Device-Gruppenbetrieb, nicht die Vermarktung einer vollständig abgenommenen Enterprise-Plattform.
