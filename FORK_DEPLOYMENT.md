# Dauerhafter T3-Fork – Deployment, PostgreSQL und eigener Connect-Einstieg

Stand: 31. Oktober 2026 · Grundlage: Repository `d2d1e4f50e`

Status: Umsetzungsplan, noch keine bereitgestellte Infrastruktur. Ergänzt [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md). Alle Domains und neuen Konfigurationsnamen in diesem Dokument sind Beispiele beziehungsweise Vorschläge. Es wurden weder VPS noch Cloudflare, Git-Remotes, Konten oder Deployments verändert.

## 1. Festgelegtes Ziel und Empfehlung

Der Fork bleibt dauerhaft eigenständig und übernimmt regelmäßig Änderungen aus T3 upstream. Die vorhandene VPS wird Main Node; Clients erreichen die eigene Plattform unter einer Cloudflare-Domain. PostgreSQL wird von Beginn an für die zentralen Plattformdaten verwendet. Nach einmaliger Anmeldung an der eigenen Connect-Instanz sollen Web und Windows-Desktop die freigegebenen Maschinen automatisch anzeigen. Mobile bleibt zunächst unverändert und kann später hinzukommen.

**Empfohlener Aufbau:** Main Node und PostgreSQL laufen auf der VPS. Der vorhandene Connect-Code aus `infra/relay` läuft als eigene Cloudflare-Worker-Instanz unter einer eigenen Subdomain. Die Clients verwenden die bereits vorhandene Connect-Anmeldung, Discovery und direkte Environment-Verbindungen. Das ergibt einen gemeinsamen Produkteinstieg mit zwei technischen Backend-Rollen.

Diese Aufteilung hält die Änderungen am Upstream klein: Connect ist schon für Cloudflare Workers gebaut und verwendet bereits PostgreSQL. Es wird nicht parallel ein zweites Maschinenverzeichnis implementiert. Die VPS steuert Workflows; sie muss nicht sämtliche Terminal-, Chat- und Dateiströme der verbundenen Maschinen weiterleiten.

Die eigene Domain allein ersetzt weder Connect noch eine Anmeldung. Für die erste Version werden eine eigene Clerk-Instanz, ein eigenes Cloudflare-Deployment, ein Linux-Container-Image und ein eigener Windows-Desktop-Build benötigt. Manuelle Builds und Updates genügen anfangs; breite Release-Automatisierung und weitere Betriebssysteme sind keine Voraussetzung. „Eigener Betrieb“ bedeutet hier Unabhängigkeit vom offiziellen T3-Dienst, nicht Unabhängigkeit von Cloudflare und Clerk. Ein vollständig auf der VPS betriebenes Connect mit anderem Identity Provider wäre eine zusätzliche Portierung; sie ist zunächst nicht eingeplant.

### Anfänglich unterstützte Plattformen

| Komponente                                  | Erster Betriebsumfang                                          |
| ------------------------------------------- | -------------------------------------------------------------- |
| Main Node und Automation-Backend            | Linux auf der vorhandenen VPS, Docker Compose                  |
| PostgreSQL                                  | Persistenter Container auf derselben VPS                       |
| Connect-Broker                              | Eigener Cloudflare Worker aus dem vorhandenen Relay-Code       |
| Web-Client                                  | Gemeinsamer Web-Build, von der Main Node ausgeliefert          |
| Desktop-Client                              | Eigener Windows-Build, bevorzugt als Remote-Client             |
| Automation-Worker                           | Zunächst Linux; darf auf derselben VPS laufen                  |
| Mobile                                      | Keine Entwicklung, Builds, Distribution oder Abnahme zu Beginn |
| Weitere Desktop-Systeme / CPU-Architekturen | Keine eigenen Pakete oder Releases zu Beginn                   |

Connect und das zentrale Maschinenverzeichnis bleiben Bestandteil des ursprünglichen Plans. Die Eingrenzung betrifft Plattformen und Betriebsaufwand, nicht das Funktionsziel. Ein zusätzlicher physischer Worker ist für den Durchstich nicht erforderlich: Ein getrenntes Linux-Environment auf derselben VPS kann Enrollment und Dispatch abdecken, solange Ressourcen und Datenverzeichnisse sauber getrennt sind.

## 2. Was bereits existiert und was angepasst werden muss

Die vorhandene [Connect-Architektur](docs/internals/t3-connect.md) trennt drei Aufgaben:

1. Ein Cloud-Konto verknüpft Environments und liefert dem Client deren Liste.
2. Der Relay-Dienst vermittelt eine kurzlebige, an den Client-Schlüssel gebundene Bootstrap-Berechtigung.
3. Der Client erhält seine eigene Session direkt vom Ziel-Environment und kommuniziert mit dessen HTTP-/WebSocket-Endpunkt.

Das Relay ist dabei normalerweise kein Proxy für den laufenden Chat. Die vorhandene [Discovery](packages/client-runtime/src/relay/discovery.ts) und der [Connection-Runtime](docs/internals/connection-runtime.md) passen bereits zu dem gewünschten Verhalten.

Im [Relay-Datenbankmodul](infra/relay/src/db.ts) existieren PostgreSQL, Drizzle, Effect-Pg und Hyperdrive bereits. Die Deployment-Komposition provisioniert allerdings heute PlanetScale-Ressourcen und Stage-Branches. Für diesen Fork muss sie zusätzlich eine betreibereigene PostgreSQL-Instanz akzeptieren. Das ist mehr als das Ändern einer Domain oder `DATABASE_URL`.

Die bestehende [Connect-Konfiguration](docs/operations/connect-setup.md) unterstützt eigene Relay-/Clerk-Werte. Clients betten diese Werte teilweise beim Build ein. Ein normaler, unveränderter T3-Client kann deshalb nicht automatisch als beliebiger eigener Connect-Client vorausgesetzt werden.

## 3. Deployment auf VPS und Cloudflare

### 3.1 Vorgeschlagene Adressen

| Adresse                                             | Aufgabe                                                                    | Ausführung                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `https://code.example.com`                          | Web-App, Anmeldungseinstieg und öffentlicher Main-Node-/Automation-Zugang  | Auf der VPS gebautes Fork-Deployment, über Cloudflare erreichbar |
| `https://connect.example.com`                       | Eigener Connect-Broker: Konto, Maschinenliste, Bootstrap, Tunnelverwaltung | Eigene Instanz von `infra/relay` als Cloudflare Worker           |
| Zugewiesene Hosts unter einer eigenen Tunnel-Domain | HTTP/WebSocket eines registrierten Environments                            | Cloudflare Tunnel zur jeweiligen Maschine                        |
| Private PostgreSQL-Adresse                          | Automation- und Connect-Datenbank                                          | VPS, ohne öffentlich freigegebenen PostgreSQL-Port               |

Die tatsächlichen Tunnel-Hostnamen folgen dem bestehenden Allocator. Domains werden einmal zentral als Deployment-Konfiguration festgelegt. DNS-Zone und TLS-Zertifikate müssen die gewählte Hostnamen-Tiefe unterstützen; eine Cloudflare-verwaltete Domain allein garantiert noch keine passende Wildcard-Abdeckung.

Die Main Node wird ebenfalls als Environment im eigenen Connect registriert. Der Client kennt ihre stabile Environment-ID als Plattform-Metadatum und kann sie als Automation-Owner bevorzugt anzeigen. Ihre autoritativen Verbindungs-URLs kommen aus dem Registry-Eintrag. Der Web-Hostname wird nicht ungeprüft als Alias eines verwalteten Endpunkts ausgegeben; bestehende Endpoint-/DPoP-Prüfungen bleiben erhalten.

### 3.2 Prozesse und persistente Daten

Für die Linux-VPS wird ein eigenes Docker-Compose-Deployment geplant. Die dafür genannten Dateien sind neu zu erstellen; dieses Dokument ist noch kein startbares Deployment:

- **Main Node:** Ein Produktionsbuild von `apps/server` mit eigener Automation-Layer und dem dazugehörigen Web-Build. Kein Vite-Dev-Server und keine Build-Arbeit beim Containerstart.
- **PostgreSQL:** Eine fest gepinnte, unterstützte stabile Major-Version mit persistentem Volume. Version und Ressourcenlimits werden vor dem ersten Build festgelegt; keine Release Candidates und kein bewegliches `latest`-Tag.
- **Öffentlicher Ingress:** Ein eigener `cloudflared`-Connector mit festem Hostnamen zum Main-Service. Die VPS muss dafür keinen öffentlichen App-Port anbieten. Ein vorhandener Reverse Proxy kann alternativ verwendet werden, ohne die Anwendungsschnittstellen zu ändern.
- **Privater DB-Zugang:** Separater Tunnel-/VPC-Zugang für den Connect-Worker zu PostgreSQL. Dieser Zugang besitzt andere Rechte und Routing-Regeln als der öffentliche Web-Eingang.
- **Migrationen:** Ein einmaliger Release-Job mit eigener Datenbankrolle. Der laufende API-Prozess besitzt keine allgemeinen Schemaänderungsrechte.
- **Backups:** Geplanter Job für PostgreSQL-Backups/WAL und Artefakte mit einem Speicherziel außerhalb der VPS.

Persistente Volumes enthalten PostgreSQL, das eigene T3-Home der Main Node, Artefakte und nötige Connector-Konfiguration. Credentials werden zur Laufzeit über geschützte Secret-Dateien beziehungsweise Deployment-Secrets bereitgestellt, nicht in Images oder öffentliche Client-Konfiguration eingebaut.

Der verwaltete Environment-Connector muss den validierten Loopback-Ursprung seiner T3-Umgebung erreichen. Bei Containerbetrieb läuft er deshalb im passenden Netzwerk-Namespace beziehungsweise innerhalb der vom T3-Server verwalteten Laufzeit. Der Fork lockert die vorhandene Loopback-Prüfung nicht zu beliebigen Docker-/LAN-Zielen.

Für den Start bleiben Main Node und Koordinator ein Prozess. Später kann der Queue-Worker getrennt skaliert werden. PostgreSQL auf derselben VPS spart Infrastruktur, erzeugt aber einen gemeinsamen Ausfallpunkt. Separate Datenbank-Hosts oder Replikation sind eine spätere Betriebsoption; ein externes Backup gehört bereits zur ersten Version.

### Konkreter Container- und Desktop-Zuschnitt

`deploy/fork/` soll einen Dockerfile für den Produktionsbuild, eine Compose-Datei, eine Konfigurationsvorlage und kurze Betriebsbefehle erhalten. Das Main-Image enthält Server und Web-Assets aus demselben Fork-Stand. Automation wird zunächst im Serverprozess aktiviert; kein zusätzlicher allgemeiner API-Server und kein separater Message Bus sind erforderlich. PostgreSQL und gegebenenfalls `cloudflared` sind eigene Compose-Services. Der Connect-Worker wird separat in Cloudflare deployed, nicht als weiterer Compose-Container.

Ein Linux-Worker kann als zusätzlicher Service auf derselben VPS laufen, mit eigenem T3-Home, Workspace-Volume und Provider-Anmeldung. Das ist eine dauerhafte Ausführungsumgebung; der Docker-Container für den Backend-Betrieb stellt noch keine pro Step erzeugte Sandbox bereit. Echte Step-Sandboxes und deren Supervisor folgen in der vorgesehenen Sandbox-Etappe. Der Main-Prozess bekommt dafür nicht vorsorglich Zugriff auf den Host-Docker-Socket.

Der anfängliche manuelle Ablauf ist: passendes Linux-Image bauen und zur VPS übertragen oder aus einer eigenen Registry laden, Konfiguration und Volumes bereitstellen, PostgreSQL starten, Migrationen ausführen, Main/Ingress starten und Readiness prüfen. Aktualisierungen verwenden denselben Ablauf mit festem Image-Stand und vorherigem Backup; bei unverändertem Schema entfällt die Migration. Eine Registry und automatisierte Deployment-Pipeline sind bequem, aber keine Voraussetzung für den ersten eigenen Betrieb.

Der Windows-Desktop braucht einen eigenen Build, weil Electron die Web-Oberfläche aus seinem Bundle lädt. Ein neues VPS-Backend allein ergänzt keine Tabs im offiziellen Desktop-Client. Beide Fork-Oberflächen werden aus `apps/web` gebaut; eine zweite UI-Implementierung ist nicht geplant. Der bestehende [Desktop-Modus ohne lokales Environment](docs/internals/remote.md#desktop-without-a-local-environment) erlaubt `localEnvironmentEnabled=false`. Damit verbindet sich Windows mit Linux, ohne dass dort die neuen Automation-Services oder PostgreSQL laufen müssen. Zunächst genügt ein intern verteilter Build mit manuellen Updates; öffentliche Installer-Distribution, Signierung und Auto-Update folgen bei Bedarf.

### 3.3 Privates PostgreSQL für den Connect-Worker

Der Main-Prozess nutzt einen normalen lokalen PostgreSQL-Pool. Der Cloudflare-Worker verwendet Hyperdrive mit deaktiviertem Query-Cache für Verbindungen, Rechte und Zustellzustände. Das entspricht der vorhandenen Absicht im Relay, muss aber auf das eigene Connection-Limit angepasst werden.

Als bevorzugter Weg wird **Hyperdrive → Workers VPC Service → Cloudflare Tunnel → PostgreSQL auf der VPS** geprüft. Cloudflare dokumentiert diesen privaten Zugang einschließlich TLS-Anforderungen. Verfügbarkeit und Beta-Status werden im eigenen Account vor dem Deployment geprüft. Als dokumentierte Alternative existiert Tunnel plus Access-Service-Authentifizierung. Die Produktionsverbindung muss das DB-Zertifikat geeignet prüfen; ein öffentlich erreichbarer Port 5432 ist nicht die geplante Lösung. [Cloudflare: Hyperdrive über Workers VPC](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/), [Alternative mit Tunnel und Access](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/)

Das vorhandene Alchemy-Paket muss die gewählte Bindung unterstützen; andernfalls wird eine vorab provisionierte Hyperdrive-/VPC-Ressource durch eine kleine Deployment-Erweiterung referenziert. Diese Integrationsprüfung findet vor dem Ausbau der Automations statt. Der Worker erhält ausschließlich Zugang zur Connect-Datenbank.

### 3.4 Cloudflare und App-Transport

Cloudflare unterstützt WebSockets; bestehende Verbindungen können trotzdem durch Netzwerk-/Edge-Neustarts beendet werden. Deshalb werden Reconnect und Wiederaufnahme mit dem vorhandenen Connection-Supervisor getestet. Lange Agentenläufe dürfen keine minutenlang offene HTTP-Request-Antwort als Ausführungszustand benötigen. [Cloudflare: WebSockets](https://developers.cloudflare.com/network/websockets/)

Für das Deployment sind folgende Punkte konkret zu prüfen:

- API-, OAuth-, Bootstrap-, Webhook- und WebSocket-Routen werden nicht gecacht; Hash-Assets dürfen gecacht werden, die HTML-Einstiegsdatei darf keine veralteten Build-Verweise dauerhaft ausliefern.
- WAF-/Bot-Regeln dürfen native Clients, CLI-OAuth und signierte SaaS-Webhooks nicht in eine Browser-Challenge schicken. Ausnahmen werden auf die jeweiligen Routen und Auth-Verfahren begrenzt.
- Kein zusätzlicher interaktiver Cloudflare-Access-Login vor sämtlichen App-Routen: Das würde den vorhandenen Mobile-/CLI-/Webhook-Fluss verändern. App-Zugriff bleibt durch T3-/Connect-Authentifizierung geschützt. Der private DB-Tunnel ist eine separate Zugriffsklasse.
- Origin-, CORS- und Redirect-Prüfungen erlauben die eigenen Web-/Windows-Desktop-Ursprünge explizit; keine pauschale Freigabe beliebiger Origins.
- Upload-/Proxy-Limits werden gegen Anhänge und Artefakte geprüft. Große Archive erhalten einen passenden Transferpfad oder Object Storage, statt sie ungeprüft durch den WebSocket zu senden.
- Proxys entfernen eingehende, vom Client kontrollierbare Forwarding-Header und setzen nur die tatsächlich benötigten Werte. Bestehende Link-Proofs und externe URL-Bindungen werden nicht durch spontane Host-Rewrites umgangen.

Die bereits vorhandene Cloudflare-Domain wird bei Umsetzung auf ihren tatsächlichen Betriebsmodus geprüft: DNS-Verwaltung, HTTP-Proxy und Tunnel sind unterschiedliche Dinge. Konkrete Hostnamen und Zone-IDs werden erst aus der Betreiber-Konfiguration übernommen.

## 4. Einmal verbinden, Maschinen in allen Clients sehen

### 4.1 Benutzerfluss

1. Der Benutzer öffnet die eigene Web-App oder den Windows-Fork-Desktop-Client und meldet sich am eigenen Connect an.
2. Der Client lädt das für dieses Konto autorisierte Maschinenverzeichnis. Main Node und registrierte Maschinen erscheinen als getrennte Environments mit Online-/Offline-Zustand.
3. Beim Öffnen einer Maschine fordert der Client über den Broker eine Bootstrap-Berechtigung an, tauscht sie beim Environment gegen seine eigene Session und nutzt danach dessen bestehende APIs.
4. Ein zweiter Client mit demselben Konto sieht dieselben freigegebenen Maschinen, ohne erneut jede Maschine manuell zu pairen. Er erstellt trotzdem eigene kryptographische Schlüssel und Sessions.
5. Die Automation-Ansicht wird von der Main Node geladen. Der Chat eines Worker-Threads bleibt bei seinem Environment; ein Sandbox-Archiv kommt nach deren Löschung aus dem zentralen Artefaktspeicher.

Für die erste Version zeigen eigene Builds fest auf dieses Deployment. So ist die zentrale Anlaufstelle ohne einen neuen universellen Login-Mechanismus erreichbar. Optional folgt später „Eigenen Hub hinzufügen“ mit URL-basierter Metadatenauflösung und Runtime-Auswahl. Dazu müssten Clerk-Instanz, Issuer, Relay-Origin und alle lokalen Account-/Credential-Caches gemeinsam umgeschaltet und isoliert werden; nur eine URL im Formular zu ändern reicht nicht. Mehrere parallele Hubs sind kein MVP-Erfordernis.

### 4.2 Maschinen hinzufügen und Rechte vergeben

Ein Fork-Server wird mit seinem lokalen Provider-Konto auf der Zielmaschine eingerichtet und am eigenen Connect angemeldet. Der bestehende Cloud-Link-Prozess bestätigt die Verbindung und richtet einen verwalteten Tunnel ein. Die Maschine ist dadurch für ihr autorisiertes Konto discoverable.

In einem zweiten, im UI zusammengefassten Schritt wird sie als Automation-Ziel registriert: Provider-Fähigkeiten, erlaubte Projekte, Parallelität und Dispatch-Rechte werden festgelegt. Die Main Node erhält eine eigene begrenzte Environment-Berechtigung beziehungsweise einen passenden Peer-Link. Sie übernimmt keine Browser-Session des Benutzers. Ein headless Enrollment ohne verfügbaren Device-Login bekommt einen ausdrücklichen Pairing-Weg; es wird kein dauerhaftes Benutzer-Token aus einem Client kopiert.

Die erste Version verwendet das bestehende kontobezogene Link-Modell. „Alle verbundenen Maschinen“ bedeutet alle für dieses Konto freigegebenen Maschinen. Ein teamweites Verzeichnis braucht zusätzlich Mitgliedschaften und Maschinen-Grants; es wird nicht dadurch erzeugt, dass ein Administrator die Maschine einmal verwendet hat.

Es gibt zwei getrennte Freigaben: `clientAccess` für Benutzer und `automationExecution` für die Main Node. Bezeichnungen sind vorgeschlagene fachliche Rechte, noch keine vorhandenen RPC-Scopes. Widerruf der einen Freigabe widerruft nicht automatisch die andere. Eine gemeinsame „Maschine vollständig trennen“-Aktion führt beide Schritte nachvollziehbar aus und regelt laufende Runs.

Kein transitives Vertrauen: Wenn Main Node A einen Peer-Link zu B hat und B einen Link zu C, erscheint C nicht automatisch bei A oder in allen Clients. Auch ein Maschinenname oder eine erfolgreiche TLS-Verbindung ersetzt keine verifizierte Environment-Identität.

### 4.3 Verhalten bei Änderungen und Ausfällen

- Neue Maschinen erscheinen nach Registry-Refresh. Die vorhandene Discovery wird verwendet; kein zweiter Reconnect-Loop in der Automation-UI.
- Offline-Maschinen bleiben in der Liste sichtbar. Bereits geladene Daten sind als gecacht erkennbar; Automation wartet auf das gewählte Ziel oder verwendet nur einen ausdrücklich erlaubten Pool.
- Konto-Logout entfernt die zu diesem Hub gehörenden Sessions und Caches, nicht unabhängig direkt gekoppelte Environments.
- Widerruf verhindert neue Bootstrap-Sessions. Bereits aktive Environment-Sessions müssen zusätzlich widerrufen und gegebenenfalls offene Sockets geschlossen werden; der bestehende Ablauf wird darauf getestet und bei Bedarf ergänzt.
- Ein Connect-Ausfall blockiert Discovery und neue Cloud-Bootstraps. Bereits bestehende direkte Environment-Verbindungen müssen nicht sofort abbrechen; eine spätere Session-Erneuerung kann dennoch auf Connect angewiesen sein.
- Ein VPS-Ausfall stoppt zentrale Workflow-Entscheidungen und, bei lokaler Connect-Datenbank, auch die Registry. Worker behandeln abgelaufene Leases gemäß dem Architekturplan. Ein Cloudflare-Worker macht die gemeinsam ausgefallene Datenbank nicht hochverfügbar.

Kurzlebige Sandboxes werden standardmäßig unter ihrem Workflow/Worker angezeigt, statt den normalen Maschinenkatalog mit jedem Step zu füllen. Live-Zugriff wird ausdrücklich autorisiert und Archive bleiben nach Cleanup erhalten.

## 5. PostgreSQL von Beginn an

### 5.1 Datenverantwortung

| Bestand                                                                                    | Speicher                                                            | Eigentümer                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------ |
| Workflows, Agent-/Skill-Versionen, Trigger-Inbox, Runs, Attempts, Outbox, Memory-Metadaten | PostgreSQL-Datenbank `fork_automation`                              | Main Node / Automation-Service |
| Konto-Environment-Links, Endpoint-Zuordnung, Bootstrap-/Relay-Zustand                      | PostgreSQL-Datenbank `fork_connect`                                 | Eigener Connect-Broker         |
| T3-Threads, Provider-Sessions und lokale Projektionen einer Maschine                       | Bestehende lokale `statev2.sqlite` der jeweiligen Fork-Installation | Das betreffende T3-Environment |
| Große Archive, Git-Bundles und Anhänge                                                     | Persistenter Artefaktspeicher, später bei Bedarf Object Storage     | Automation-Artefaktservice     |

Es gibt keine neue Automation-SQLite-Datenbank und keinen geplanten späteren Umzug von Automation zu PostgreSQL. Die lokale T3-Persistenz bleibt wegen der gewünschten Upstream-Nähe erhalten. Soll auch diese vollständig auf PostgreSQL wechseln, wäre das ein gesonderter Umbau von EventStore, Projektionen, Migrationen und lokalen/offlinefähigen Installationen.

Connect und Automation erhalten jeweils eine eigene Runtime-Rolle, Migrationsrolle und Migrationshistorie. Rollen haben nur Rechte auf ihre Datenbank. Die Main Node fragt Connect fachlich über Services/API ab und greift nicht als zweiter Writer auf dessen Tabellen zu. PostgreSQL als gemeinsamer Server bedeutet keine gemeinsame Anwendungstransaktion über beide Datenbanken.

### 5.2 Schema und Queue

Automation nutzt typisierte Spalten für IDs, Zustände, Versionen, UTC-Zeitpunkte, Leases und häufige Filter. `jsonb` eignet sich für versionierte Definitionen und Payloads; der gesamte Zustand wird nicht als ein großes überschreibbares JSON-Dokument gespeichert. Artefakte bleiben außerhalb der Queue-Zeilen.

Geplant sind Unique Constraints für Command-IDs, externe Zustellungen pro Connector/Binding und StepAttempt-Dispatch-Schlüssel. Indizes folgen den tatsächlichen Zugriffen: fällige Queue-Arbeit, aktive Leases, Runs nach Owner/Status/Zeit sowie geordnete Events pro Run. Partielle Indizes begrenzen den aktiven Queue-Index; historische Runs werden paginiert abgefragt.

Queue-Claims erfolgen in kurzen Transaktionen mit `FOR UPDATE SKIP LOCKED`, persistierter Lease und Generation. Danach wird committed; Agentenstart und Netzwerkzugriffe passieren außerhalb der Transaktion. Zustandswechsel desselben Runs werden zusätzlich über Revision beziehungsweise Zeilensperre serialisiert. Queue-Locking ersetzt weder Idempotenz noch das Fencing externer Seiteneffekte. [PostgreSQL: SELECT und SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)

`LISTEN/NOTIFY` kann wartende lokale Worker zusätzlich wecken. Es transportiert nur kleine Hinweise; die persistente Outbox bleibt die Wahrheit. Nach Reconnect und regelmäßigem Abgleich werden fällige Zeilen erneut gelesen. Ein dedizierter Listener benutzt eine passende langlebige Verbindung, nicht eine beliebig wechselnde Transaktions-Pool-Session. [PostgreSQL: NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

Automation verwendet direkt `@effect/sql-pg` im bestehenden Effect-Stil. Der Relay-Bestand behält sein vorhandenes Drizzle-/Effect-Pg-Modell. Ein zusätzlicher ORM-Wechsel bringt für dieses Feature keinen Nutzen. Tests für Sperren, Constraints, Migrationen und konkurrierende Claims laufen gegen echtes PostgreSQL; reine Zustandsentscheidungen bleiben ohne Datenbank testbar.

### 5.3 Verbindungen und Migrationsbetrieb

Der lokale Pool und Hyperdrives Origin-Limit bekommen ein gemeinsames Verbindungsbudget, das Platz für Migrationen, Backups und Administration lässt. Die derzeit im Relay gesetzten Werte werden nicht ungeprüft für eine kleinere VPS übernommen. Kein Remote-Agent bekommt für jeden Step eine PostgreSQL-Verbindung.

Migrationen laufen einmal pro Release mit Sperre gegen parallele Ausführung und einer direkten geeigneten Verbindung. Runtime-Prozesse prüfen danach die kompatible Schema-Version. Additive Änderungen kommen vor Code, der sie voraussetzt; destruktive Bereinigung folgt erst, wenn ältere unterstützte Clients/Worker sie nicht mehr benötigen. PostgreSQL-Major-Upgrades sind eigene Betriebsänderungen.

Die Datenbanken liegen ausschließlich im privaten Netzwerk. Ein DB-Ausfall führt zu einem sichtbaren nicht bereiten Dienst; der Server darf nicht still eine leere lokale Ersatzdatenbank anlegen oder einen Webhook erfolgreich bestätigen, dessen Inbox-Commit fehlgeschlagen ist.

## 6. Konkrete Änderungen im Repository

Die Tabelle benennt vorhandene Anknüpfungspunkte. Neue Pfade werden ausdrücklich als Vorschlag markiert. Kein globales Umbenennen aller `t3`-Bezeichner; Produkt- und Deployment-Werte werden an wenigen Stellen gekapselt.

| Bereich / vorhandener Code                                                                                                                                                                                                | Geplante Änderung                                                                                                                                                                                                         | Abnahme                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Public Build Config](scripts/lib/public-config.ts), [Server Public Config](apps/server/src/cloud/publicConfig.ts)                                                                                                        | Gemeinsames Fork-Deployment-Profil: Produktkennung, eigenes Web/Relay, Clerk, Main-Environment-ID und Release-Kanal. Bestehende `T3CODE_*`-Variablen wiederverwenden; neue nur für fehlende Werte                         | Alle selbst gebauten Clients und Server verwenden dieselbe eigene Instanz; keine Secrets im Bundle                     |
| [Relay DB](infra/relay/src/db.ts), [DB-Modus](infra/relay/src/dbConfig.ts), [Alchemy Stack](infra/relay/alchemy.run.ts)                                                                                                   | Providerneutrale DB-Bindung und eigener Deployment-Modus für vorhandenes PostgreSQL/Hyperdrive; PlanetScale-Provisioning bleibt ein getrennter bestehender Pfad                                                           | Eigenes Deployment erstellt keine unbeabsichtigte PlanetScale-Datenbank; Connect-Migrationen laufen auf `fork_connect` |
| [Relay Worker](infra/relay/src/worker.ts), [Relay Config](infra/relay/src/Config.ts)                                                                                                                                      | Eigene Issuer-/Domain-/Clerk-Werte und Region passend zum VPS-Standort; optionales Monitoring, Push und Limits vom Upstream-Produkt entkoppeln                                                                            | Keine feste Bindung an T3 Chat, fremde Telemetrie oder die bisherige Datenbankregion                                   |
| [Environment Links](infra/relay/src/environments/EnvironmentLinks.ts), [Environment Credentials](infra/relay/src/environments/EnvironmentCredentials.ts)                                                                  | Bestehende Konto-/Maschinen- und Bootstrap-Logik nutzen; ergänzende Hub-/Main-Node-Metadaten additiv und namespaced einführen                                                                                             | Main Node und registrierte Maschine werden nach Anmeldung in zwei Clients gelistet                                     |
| [Endpoint Provider](infra/relay/src/environments/ManagedEndpointProvider.ts), [Allocations](infra/relay/src/environments/ManagedEndpointAllocations.ts)                                                                   | Eigene DNS-Zone und Tunnel-Ressourcen, überprüfte Kontingente, idempotentes Provisioning/Cleanup beibehalten                                                                                                              | Maschine hinter NAT ist über ihren verwalteten Endpunkt erreichbar; Neustart erhält die Zuordnung                      |
| [CloudLink](apps/server/src/cloud/CloudLink.ts), [Cloud Config](apps/server/src/cloud/config.ts)                                                                                                                          | Anmeldung am eigenen Broker, Trust-Bindung und Widerruf prüfen; keine automatische Übernahme offizieller gespeicherter Links                                                                                              | Ein offizieller und ein Fork-Account/Environment können sich nicht gegenseitig überschreiben                           |
| [Managed Relay Client](packages/client-runtime/src/relay/managedRelay.ts), [Discovery](packages/client-runtime/src/relay/discovery.ts), [Cloud Account Service](packages/client-runtime/src/relay/cloudAccountService.ts) | Bestehende Discovery verwenden; Main-Node-Auswahl und Automation-Capabilities ergänzen; bei Runtime-Hub-Auswahl Registry-/Cache-Schlüssel um den Hub-Issuer erweitern                                                     | Wechsel/Logout vermischt keine Accounts oder Sessions; keine zweite Transportsteuerung                                 |
| [Web Relay Layer](apps/web/src/cloud/managedRelayLayer.ts), bestehende Connect-UI                                                                                                                                         | Eigenes Branding und Login-Ziel; Main Node und Maschinen auffindbar machen; Windows-Desktop-OAuth an die eigene App-ID anpassen; Mobile unverändert lassen                                                                | Web und Windows-Desktop verbinden sich mit demselben eigenen Katalog                                                   |
| `apps/server/src/automation/persistence/` – neu                                                                                                                                                                           | PostgreSQL-Services, Tabellen, Migrationen, Inbox/Outbox und eigene Schema-Version                                                                                                                                        | Restart und konkurrierende Zustellung werden gegen echtes PostgreSQL geprüft                                           |
| `apps/server/src/automation/t3/` und `automation/workers/` – neu                                                                                                                                                          | Registry-Eintrag einer Maschine mit ihrer ausdrücklich erteilten Dispatch-Berechtigung verbinden; Enrollment und Widerruf servicebasiert anbieten                                                                         | Sichtbarkeit gewährt allein noch keine Ausführungsrechte; umgekehrt veröffentlicht ein Peer-Link keine Maschine        |
| [Desktop Build](scripts/build-desktop-artifact.ts), [Electron Updater](apps/desktop/src/electron/ElectronUpdater.ts), [Desktop Update Flow](apps/desktop/src/updates/DesktopUpdates.ts)                                   | Eigene Windows-App-ID, Protokolle und Datenpfade anbinden; automatischen Updater zunächst deaktivieren, Signierung und eigene Feeds später                                                                                | Offizielles T3 und Fork sind parallel nutzbar; manuelle Updates bleiben beim Fork                                      |
| [CLI Update](apps/server/src/cli/update.ts), [Self Update](apps/server/src/cloud/selfUpdate.ts), [npm Release Lookup](apps/server/src/cloud/npmRelease.ts), `packages/shared/src/cliRelease.ts`                           | Offizielle Update-/Installationspfade für Fork-Instanzen sperren oder durch manuelle Fork-Hinweise ersetzen; eigenes CLI-Paket erst bei Bedarf; Containerupdates über Deployment                                          | Remote-Update installiert kein offizielles `t3` über einen Fork-Worker; Main-Container wird per Deployment ersetzt     |
| [Release CI](.github/workflows/release.yml), [Relay CI](.github/workflows/deploy-relay.yml)                                                                                                                               | Zunächst nur benötigte Linux-/Windows-Builds und Relay-Deployment konfigurieren; manuelle Ausführung genügt. Unbenutzte Upstream-Publish-/Mobile-Jobs im Fork deaktiviert lassen; keine eigene Mobile-Pipeline entwickeln | Ein Fork-Push publiziert weder unter Upstream-Namen noch mit Upstream-Zielen                                           |
| `deploy/fork/` – neu                                                                                                                                                                                                      | Compose-Datei, Main-Image, Env-Beispiel, Migration-/Health-/Backup-Konfiguration und explizite Stage-Werte                                                                                                                | Reproduzierbares Staging und Produktion mit getrennten Daten und Schlüsseln                                            |
| `infra/fork-connect/` – neu, nur Deployment-Komposition                                                                                                                                                                   | Eigenen Cloudflare-Stack aus wiederverwendeten Relay-Layern zusammensetzen; keine Kopie der fachlichen Relay-Services                                                                                                     | Änderungen am Relay können weiterhin aus Upstream übernommen werden                                                    |
| `docs/operations/fork-deployment.md` – bei Implementierung                                                                                                                                                                | Dauerhafter Betriebsleitfaden aus dem tatsächlich implementierten Aufbau                                                                                                                                                  | Neuinstallation, Upgrade, Restore und Maschinen-Anbindung nachvollziehbar                                              |

Die Build-Konfiguration ist keine frei eingebbare Sammlung beliebiger Update-URLs für Agenten. Produktionswerte kommen aus dem Betreiber-Deployment. Vorhandene offizielle Installationshinweise in Fehlern, Pairing-Links und Update-Dialogen werden ebenfalls auf ihre Fork-Ziele geprüft; nur das App-Icon auszutauschen reicht nicht.

Die aktuelle Relay-Komposition bindet Ressourcen teilweise direkt in Worker-/DB-Modulen. Für eine eigene Komposition sind daher kleine Dependency-Injection-Änderungen erforderlich: Runtime bekommt eine DB-/Hyperdrive-Bindung, Deployment provisioniert sie. Diese Trennung wird als begrenzter Integrationspatch gepflegt, nicht als Kopie von `infra/relay` mit auseinanderlaufender Logik.

## 7. Anmeldung, öffentliche Konfiguration und optionale Dienste

### 7.1 Erste Version mit eigener Clerk-Instanz

Die bestehenden Web-/Windows-Electron- und benötigten Linux-CLI-Anmeldewege werden mit eigenen Clerk-Schlüsseln, Audience und OAuth-Client konfiguriert. Callback-URIs, Desktop-Deep-Link-Schemes und erlaubte Origins müssen zur eigenen Distribution passen. Mobile-Anmeldewege und Android-/iOS-Kennungen werden zunächst nicht angepasst. Der vorhandene [Setup-Runbook](docs/operations/connect-setup.md) ist dabei die Codebasis; Verfügbarkeit headlessfähiger Login-Verfahren wird im eigenen Account geprüft.

Die öffentlichen Werte umfassen bereits `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE` und `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. `T3CODE_HOSTED_APP_URL` existiert serverseitig; konsistente Verwendung für alle Fork-Link-Erzeuger wird ergänzt. Neue vorgeschlagene Werte für Produkt-/Main-Node-Metadaten bekommen einen eigenen Fork-Präfix.

Clerk-Secret, Relay-Signaturschlüssel, Cloudflare-Verwaltungsrechte, Datenbankzugänge und Provider-/Source-Control-Secrets sind private Konfiguration. Cloudflare-Verwaltungstokens bleiben beim Provisioning beziehungsweise dem kontrollierten Relay-Backend; eine verbundene Maschine erhält nur ihren benötigten Tunnel-/Environment-Zugang.

Ein eigener OIDC-Provider anstelle von Clerk bleibt möglich, benötigt aber ein Auth-Adapterprojekt über alle vier Clients hinweg. Er wird nicht als einfache Konfigurationsoption zugesagt.

### 7.2 Bewusst begrenzter erster Betriebsumfang

T3-Chat-Planverknüpfung und deren Tunnelkontingente werden für den eigenen Betreiber durch eigene konfigurierbare Limits ersetzt. APNs, FCM und Live Activities bleiben für das eigene Deployment deaktiviert. Mobile-Anbindung, Push-Credentials und Store-Distribution werden erst in einer ausdrücklich gewählten späteren Mobile-Etappe bearbeitet; sie sind keine Abnahmebedingung für den Start.

Das optionale Puffern herkömmlicher Webhooks in Relay-Durable-Objects wird nicht benötigt: Automation-Webhooks gehen direkt an die Main Node und landen in PostgreSQL. Vor einem späteren Aktivieren wird entschieden, ob die vorhandene separate Inbox akzeptiert oder ein PostgreSQL-basierter Weg gebraucht wird. Die vorhandenen Cloudflare-Queues für optionale Push-Zustellung sind kein Message Bus der Workflow-Engine.

Externe Telemetrie, Fehlerberichte und Source-Map-Uploads erhalten eigene Ziele oder sind deaktiviert. Die Deployments dürfen nicht automatisch in den offiziellen T3-Account senden. Debug-Logs enthalten weder Bootstrap-Credentials noch vollständige Ticket-Payloads mit Secrets.

## 8. Konkrete Reihenfolge der Umsetzung

### D0 – Deployment-Werte und vorhandene Ressourcen erfassen

Fork-Name, Repository-/Package-Namespace, tatsächliche Domain, Linux-Distribution/CPU-Architektur/RAM/Speicher der VPS, Cloudflare-Zone und eigene Auth-Instanz festlegen. Cloudflare-Worker-/Tunnel-/Hyperdrive-Verfügbarkeit prüfen. Public Config und Secret-Konfiguration getrennt erfassen. Ein bisher produktiv verwendetes T3-Home wird weder umgehängt noch vom Fork beschrieben.

**Ergebnis:** Ein überprüfbares Deployment-Profil und ein klarer Ressourcenplan. Zugangsdaten werden bei der späteren Umsetzung über den vorgesehenen Secret-Kanal aufgenommen, nicht in diese Datei geschrieben.

### D1 – Eigene Builds und VPS-Grundbetrieb

Produktkonfiguration, manuelle Build-Ziele für Linux/Windows und Datenverzeichnisse zuerst trennen. Eine vollständige automatische Release-Pipeline ist dafür nicht erforderlich. Main-Image, PostgreSQL, persistente Volumes, öffentliche Domain und Readiness auf der VPS bereitstellen. `fork_automation` und `fork_connect` mit getrennten Rollen/Migrationen anlegen. Staging benutzt eigene Datenbanken, Domains, Schlüssel und T3-Homes; keine Verbindung mit produktiven Worker-Credentials.

**Abnahme:** Eigener Web-Build lädt von der Domain; Main Node startet nach VPS-/Container-Neustart mit erhaltenem Zustand. PostgreSQL ist vom Dienst erreichbar, aber nicht öffentlich als Port freigegeben. Ein fehlerhafter DB-Start führt nicht zu einem scheinbar gesunden Backend.

### D2 – Eigenes Connect mit PostgreSQL auf der VPS

PlanetScale-Provisioning vom Relay-Runtime lösen, eigene Hyperdrive-Bindung herstellen, Connect-Migrationen anwenden und eigenen Cloudflare-Worker mit eigenem Clerk deployen. Main Node und ein dauerhaftes Linux-Testenvironment an genau dieser Instanz registrieren; beide dürfen auf derselben VPS mit getrenntem Zustand laufen. Die eigenen Clients werden mit dieser öffentlichen Konfiguration gebaut.

**Abnahme:** Anmeldung in Web und Windows-Desktop zeigt Main Node und Testenvironment. Beide Maschinen sind öffnungsfähig; es ist kein manuelles Pairing je Maschine und je Client nötig. Eine Maschine hinter NAT braucht keine Portfreigabe. Offizielle T3-Connect-Ressourcen werden nicht verwendet.

### D3 – Maschinenkatalog mit Automation-Zielen verbinden

Main-Node-Metadatum, Worker-Enrollment, Projekt-/Provider-Fähigkeiten und getrennte Zugriffserteilung einführen. Ein minimaler Replay-Auftrag wird von der Main Node an die Testmaschine dispatcht; der resultierende Thread lässt sich vom Client öffnen.

**Abnahme:** Maschinenaufnahme, Offline/Online-Wechsel, Entzug von Client-Zugriff und Entzug von Automation-Rechten sind getrennt nachvollziehbar. Ein Registry-Eintrag ohne Dispatch-Recht reicht nicht zum Start eines Agenten.

### D4 – Workflow-MVP auf der Infrastruktur

Die Etappen 1 und 2 des Architekturplans setzen auf diesem PostgreSQL-/Connect-Aufbau auf. Allgemeine Pool-Verteilung, echte Sandboxes und Multi-Repo-Workspaces folgen nach dem ersten Ablauf. Die grundlegende Remote-Verbindung wird für dieses gewünschte Betriebsmodell früher umgesetzt als komplexe Swarm-Steuerung.

**Abnahme:** Ein Trigger an der Cloudflare-Domain erzeugt genau einen Run auf der Main Node; ein Step läuft auf der registrierten Maschine und ist aus beiden Clients einsehbar. Ausfälle zwischen Inbox, Dispatch und Abschluss sind nachvollziehbar und wiederaufnehmbar.

### D5 – Eigenständiger Release- und Wiederherstellungsbetrieb

Reproduzierbare Builds erzeugen Linux- und Windows-Artefakte mit Fork-Version und Upstream-SHA; relevante Tests laufen gegen PostgreSQL. Anfangs sind manuelle Veröffentlichung und Updates ausreichend. Automatisierte Kanäle werden erst bei regelmäßigem Distributionsbedarf ergänzt. Ein Staging-Update mit inkompatiblem Worker, ein Datenbankupgrade und ein Restore werden vor dem ersten regulären Produktionsrelease geprobt. Mobile, weitere Desktop-Builds und Push bleiben außerhalb dieser Etappe.

**Abnahme:** Client-/Worker-Update bleibt beim Fork, ein inkompatibles Protokoll wird verständlich abgefangen und ein Restore startet keine bereits veröffentlichten Aktionen blind erneut.

## 9. Release, Backup und Ausfälle

Die Main Node erhält feste Container-Image-Digests; sie aktualisiert sich nicht über den interaktiven CLI-Updater im laufenden Container. Ein Release enthält Web und Server zusammen sowie deren kompatible Automation-/Relay-/Schema-Versionen. Das Cloudflare-Relay kann unabhängig deployed werden, muss aber die unterstützten Client-/Environment-Versionen weiter bedienen.

Vor Migrationen werden Trigger und neue Dispatches pausiert; aktive Runs werden anhand der Änderung entweder fertiggestellt oder kontrolliert unterbrochen. Migration-Job, Main-Rollout und Readiness folgen nacheinander. Rollback auf ein altes Image ist nur bei kompatiblem Schema erlaubt. Destruktive Schemaänderungen benötigen einen geprüften Restore-Pfad.

PostgreSQL erhält regelmäßig vollständige Backups und, für das festgelegte Wiederherstellungsziel, WAL-Archivierung auf einen externen Speicher. Artefakte und erforderliche lokale T3-Snapshots werden mit Version/Manifest zugeordnet. Ein `docker volume` auf derselben VPS ist kein Ausfallbackup. RPO, RTO, Aufbewahrung und tatsächlich verfügbare VPS-Ressourcen werden vor Produktion festgelegt.

Restore beginnt mit deaktivierten Triggern und Publishing. Registry-Einträge und Schlüssel werden mit real noch vorhandenen Tunneln/Environments abgeglichen. Cloudflare-Ressourcen dürfen nicht allein aufgrund eines älteren Datenbankstands automatisch gelöscht werden. Automation gleicht Dispatch-Receipts, Worker-Leases, archivierte Ergebnisse und externe PRs ab, bevor neue Arbeit startet.

Überwacht werden mindestens API-/Connect-Verfügbarkeit, PostgreSQL-Speicher und Connections, Backup-Alter, Tunnelzustand, Registry-Fehler, Queue-Alter und Archiv-Rückstand. Die ersten Betriebsalarme brauchen keine große zusätzliche Monitoring-Plattform, müssen aber den Betreiber bei einem stehengebliebenen Dienst erreichen können.

## 10. Erforderliche Prüfungen für dieses Deployment

- Neuinstallation und Upgrade auf isoliertem PostgreSQL mit beiden logischen Datenbanken; keine Automation-Tabellen in Upstreams SQLite-Migrationsliste.
- Zwei Clients desselben Kontos entdecken dieselben Maschinen, verwenden aber eigene Schlüssel und Environment-Sessions.
- Ein anderes Konto sieht keine Maschinen ohne Grant; Peer-Verknüpfungen erzeugen keine transitiven Freigaben.
- Eigene URLs/Issuer/Audiences werden über Web, Windows-Desktop und die benötigte Linux-headless-Anmeldung konsistent verwendet.
- WebSocket-Reconnect, abgelaufene Bootstrap-Berechtigung, Cloudflare-Unterbrechung und DB-/VPS-Ausfall verlieren keine bestätigten Workflow-Aufträge.
- Direkte LAN-Verbindungen können neben Hub-Verbindungen bestehen; gleiche Environment-IDs werden im Client korrekt zusammengeführt, unterschiedliche Hubs vermischen keine Credentials.
- Ein widerrufener Zugang kann weder neu bootstrappen noch über eine alte aktive Session unbemerkt weiterarbeiten.
- Staging-Tunnel, Konten und Datenbanken bleiben von Produktion getrennt; Cleanup löscht keine produktiven Ressourcen.
- Automatische offizielle Update-Feeds und npm-Lookups sind für Fork-Builds deaktiviert oder passend ersetzt; Windows-Deep-Links und manuelle Installationshinweise verweisen auf den Fork. Keine Mobile-Abnahme.
- Öffentliches Webhook-Posting funktioniert ohne interaktiven Browser-Login, aber nur mit der vorgesehenen Connector-Authentifizierung; fehlgeschlagene Inbox-Commits ergeben keinen Erfolg.
- Backup und Restore werden tatsächlich auf einem isolierten Ziel durchgeführt; keine Prüfung gegen die laufende persönliche T3-Datenbank.

## 11. Noch benötigte Entscheidungen

Die Grundentscheidungen VPS, eigene Cloudflare-Domain, PostgreSQL und zentraler Maschinenzugang sind getroffen. Für die Umsetzung fehlen noch:

1. Produkt-/Fork-Name und tatsächliche Domain/Subdomains.
2. Linux-Distribution, CPU-Architektur, RAM, verfügbarer Speicher und vorhandener Container-/Proxy-Betrieb der VPS.
3. Eigene Clerk-Instanz als erster Auth-Weg oder ausdrücklich gewünschte zusätzliche OIDC-Portierung.
4. Verfügbarkeit von Workers, privaten DB-Verbindungen und verwalteten Tunneln im Cloudflare-Konto.
5. Zunächst Einzelkonto oder bereits mehrere Benutzer mit gemeinsamen Maschinen-Grants.
6. Windows-Architektur und gewünschter interner Build-/Verteilungsweg. Web und Windows sind als erste Oberflächen gesetzt; Mobile bleibt außen vor.
7. Externer Backup-Speicher, Aufbewahrung und gewünschte Wiederherstellungszeiten.

Diese Punkte blockieren die Planung nicht. Vor tatsächlichem Provisioning werden sie in das Deployment-Profil übernommen; dieses Dokument erteilt keinen Auftrag, vorhandene produktive Infrastruktur ungeprüft zu ändern.
