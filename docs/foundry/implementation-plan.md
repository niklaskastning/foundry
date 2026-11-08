# Foundry – Implementierungsplan für Features und Funktionen

Stand: 8. November 2026. Dieser Plan beschreibt Produktfunktionen, ihre Reihenfolge und funktionale Abnahmen. Sicherheits-, Betriebs-, Backup-, Performance- und technische Prüfthemen stehen im separaten [Plan für Basic-Leitplanken](basic-leitplanken.md). Architektur und Deployment bleiben die zugehörigen Entwürfe. Paket-IDs P01–P60 bleiben erhalten und sind keine GitHub-PR-Nummern. Der [Warp-Abgleich](warp-comparison.md) dokumentiert Code- und Browserbefunde getrennt nach Funktionen und UI; dieser Plan besitzt weiterhin Reihenfolge und Abnahme.

## Erledigte Implementierung und verbleibende Abnahmen

- [x] **P01, P03–P17 (Access-Modus, ohne P03N/P14Z):** Instanzeinstieg über Access, Device-Katalog, Gateway und dauerhafter Linux-Worker sind integriert. Web/Windows können denselben Worker nutzen. Funktionaler G3-Abschluss bestätigt ([#29](https://github.com/niklaskastning/foundry/pull/29), [#45](https://github.com/niklaskastning/foundry/pull/45)).
- [x] **P18a/P18b, P47:** Factories, Aufträge, Workflow-Versionen und kanonischer Definitionsimport/-export integriert ([#36](https://github.com/niklaskastning/foundry/pull/36), [#46](https://github.com/niklaskastning/foundry/pull/46), [#47](https://github.com/niklaskastning/foundry/pull/47)).
- [x] **P38a/P38b:** Zentrale Anhänge und fortlaufende Thread-Archive integriert und auf der Entwicklungs-VPS aktiviert ([#48](https://github.com/niklaskastning/foundry/pull/48), [#50](https://github.com/niklaskastning/foundry/pull/50)).
- [x] **P19:** Sequenzieller Workflow-Dispatch integriert ([#51](https://github.com/niklaskastning/foundry/pull/51)).
- [x] **P20/P21/P49a – Basisschnitt:** Run-Steuerung, manueller Definitions-/Startfluss, Navigationseinstiege und persönliche Inbox integriert; Automation auf der Entwicklungs-VPS aktiviert ([#52](https://github.com/niklaskastning/foundry/pull/52)).
- [x] **P22/P23/P24 – Implementierung:** GitHub-Polling, PR-Publishing und Zeitpläne implementiert. Die reale GitHub-App-Verbindung und ein betreuter nativer Issue-bis-PR-Workflow sind bestätigt ([#56](https://github.com/niklaskastning/foundry/pull/56)).
- [ ] **Funktionale Restabnahmen:** Instanzwechsel/Entfernen mit zwei realen Instanzen, Worker auf zweiter Maschine, Wiederverbindung beider Clients und Wiederaufnahme laufender Aufträge. Windows-Laufzeit und Bedienung der Factory bleiben offen; der bestätigte native G4-Durchstich schließt diese Restabnahmen nicht.
- [x] **P28/P29 / erster P52a-Schnitt / P49b – funktionaler Webstand:** Git-versionierte Rollen, Betriebsbindings und der Factories-first-Arbeitsplatz aus [PR #67](https://github.com/niklaskastning/foundry/pull/67) sind geliefert. [PR #72](https://github.com/niklaskastning/foundry/pull/72) bestätigt v4 mit dateibasierten Skills, Codex-MCP/Secret-Bindings, echten parallelen Swarms, Review/Fix-Runden und Web-/T3-Rückkehr für Linux/Codex. Die native Windows-Abnahme sowie weitere Connector-/Providerpfade bleiben offen; G6 und G12 sind nicht vollständig abgeschlossen.
- [ ] **P49b – erneute Produktgestaltung und Nutzerabnahme:** Der Nutzer ist mit der Gestaltung trotz funktionaler Lieferung nicht zufrieden. Der aktuelle Auftrag umfasst Audit und substanzielle Überarbeitung aller zentralen Ansichten mit realen Daten. [PR #74](https://github.com/niklaskastning/foundry/pull/74) implementiert die Änderungen; automatisierte Prüfungen, integrierter Browserpass und unabhängiges Review sind erfolgt. Die vier Reviewbefunde wurden behoben. Artefakt-/CI-Prüfungen und Deployment auf `6d8608abe2bad4054c522631ff8e28e4a753d4db` sind abgeschlossen; der integrierte Browserpass vom deployten Image bestätigt die Bedienwege. Die menschliche Designabnahme bleibt offen. Dies ist aktuelle Produktarbeit, kein kosmetischer Backlog.
- [ ] **Produktlücken:** Native Foundry-Anmeldung P03N, automatischer Katalog-Erstabruf, Einstieg ohne getrenntes T3-Pairing und Windows-Downloads im Foundry-Einstieg.
- [ ] **Zentrale Verbindungen P14Z:** Provider-, Source-Control- und MCP-Konten einmal in Foundry einrichten und auf Workern/Sandboxes nutzen.
- [x] **P48 / funktionales G11:** Git-Quellbindung, lesende Synchronisierung, Driftabgleich, dauerhafte Git-Ownership und explizite Aktivierung/Rollback sind implementiert ([#57](https://github.com/niklaskastning/foundry/pull/57)). Isoliertes PostgreSQL bestätigt Import → Git-Änderung → ungültigen Folgecommit → Runs und Inbox-Entscheidungen mit erhaltenen alten Revisionen. Der gemeinsame lokale Browserpass bestätigt Quelle/Diff/Fehler, Übernahme und gepinnte Run-Herkunft mit Inbox-Entscheidung. Die Entwicklungs-VPS liest das private Definitionsrepository; die bestehende G4-Definition wurde unverändert über [Definitions-PR #1](https://github.com/niklaskastning/foundry-definitions/pull/1) übernommen. Kein neuer nativer Writer-, Windows- oder öffentlicher SSO-Nachweis.

- [x] **P51 – Implementierung:** Aufträge im vorhandenen Workspace, auf Alternativbranch oder aus bestätigtem Git-Bundle in einen verknüpften T3-Thread übernehmen und mit neuer Revision zurückgeben. Der Folgelauf bleibt bis zur ausdrücklichen Fortsetzung pausiert. Persistenz-/Worker-Nachweise sind im Leitplanken-Plan getrennt vom lokalen UI-Pass und Entwicklungsdeployment geführt. P58 und das vollständige G12 bleiben offen; keine neue Provider-Freigabe.

Der zentrale Benutzerzugang ist noch ein Übergangsstand: Foundry-Anmeldung und eine separat autorisierte Main-T3-Sitzung werden gemeinsam geprüft. Worker-Zugriff benötigt kein eigenes Geräte-Pairing, reicht aber bisher nur die freigegebenen Thread-, Terminal- und Dateileserechte weiter; `settings:write` gehört noch nicht zum Gateway-Vertrag. Eine Anmeldung mit vollständig daraus abgeleiteten zentralen Benutzerrechten ist damit noch nicht abgenommen. Dies betrifft den Benutzerzugang, nicht die getrennte Provider-Autorisierung aus P14Z.

Die ausführlichen bisherigen Prüf- und Deploymentnachweise sind nach [Basic-Leitplanken](basic-leitplanken.md#bestehende-nachweise-und-offene-technische-abnahmen) verschoben. Offene Abnahmen werden durch diese Aufteilung nicht als erledigt markiert.

**P58a – erster Schnitt:** Die versionierte HTTP-API und ihr maschinenlesbarer
Vertrag verwenden die vorhandenen Benutzersitzungen und zentralen Services.
Funktionale HTTP-/PostgreSQL-Nachweise bestätigen UI/API-Gleichheit,
Command-Wiederholung und Rechteabweisung. Maschinen-Ausführung, P58b/MCP und
vollständiges G12 bleiben offen; der Schnitt erteilt keine neue Provider-Freigabe.

## Nächste Produktlieferungen

Priorität haben große nutzbare Fähigkeiten. P17/G3, der sequenzielle Factory-Kern, Git-Ownership und T3-Handoff werden nicht erneut implementiert; offene Plattform-/Betriebsabnahmen oben und in Basic-Leitplanken bleiben davon unabhängig bestehen. Die Etappen sind Ergebnisse, keine Aufforderung zu einem einzigen großen PR. Bestehende P-IDs bleiben die fachlichen Arbeitspakete.

| Reihenfolge                                        | Nutzbares Ergebnis                                                                                                                                             | Pakete und Voraussetzung                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Produktiver Factory-Arbeitsplatz — aktuell** | Aufgaben, nächste Entscheidungen und Ergebnisse in allen zentralen Ansichten verstehen und bedienen; v4-Konfiguration, Swarms und Reviewrunden nachvollziehen. | Erneute P49b-Gestaltung auf geliefertem P28/P52/P29/P32/P33-Stand. Browser-/Review- und Auslieferungsnachweis in PR #74 abgeschlossen; menschliche Designabnahme bleibt getrennt offen. |
| **Parallel · Reproduzierbare Sandboxes**           | Frische Linux-Umgebung mit Profil starten, beobachten, archivieren, löschen und Arbeit wieder aufnehmen.                                                       | P34–P40 einschließlich P37 und Archive P38a/P38b in eigenständiger Umsetzung, noch nicht ausgeliefert. UI integriert nur vorhandene Daten/Actions mit Backend-Capability.               |
| **Danach · Qualität vergleichen und verbessern**   | Runs bewerten, Konfigurationen auf denselben Aufgaben vergleichen und belegte Änderungs-PRs vorschlagen.                                                       | P54 → P55 → P56 → P57. Belegte Betriebszahlen können früher helfen; fehlende Qualitäts-/Kostendaten bleiben unbekannt.                                                                  |
| **Danach · Repositoryübergreifende Arbeit**        | Ein Auftrag liefert getrennte Änderungen/PRs über mehrere Repositories, später gemeinsamer Agent-Step.                                                         | P30 → P31 auf Rollen, Workspace-Zuordnung und Ausführungskapazität. Bei konkretem Bedarf vor der Qualitätslieferung priorisierbar.                                                      |

Koordinierte Parallelität mit Poolmapping und Kapazitätssteuerung ist aus PR #66/#70/#71 vorhanden; v4 aus PR #72 ergänzt persistente Swarm-/Loop-Zustände. Diese Funktionen werden für die aktuelle UI wiederverwendet, nicht als noch ausstehender Grundlagenbau geführt.

**Begleitende Produktpfade:** P58a bietet inzwischen Factory-begrenzte Maschinen-Leseabfragen mit Ausgabe, Ablauf und Widerruf eigener Credentials. Maschinen-Start/-Steuerung und P58b erschließen künftig weitere Services für CI und Agenten; sie müssen die Rollenlieferung nicht blockieren. P03N/P05/P12 schließen native Anmeldung und vollständigen Instanzeinstieg; der bestehende Access-Modus erlaubt vorherige Featurearbeit. P14Z/P52 bauen zentrale Ressourcen passend zu den jeweils benötigten Workern und Rollen aus. P50 bleibt ein optionaler Koordinator auf der vorhandenen Steuerung. P25/P41–P43/P59/P60 sowie P44/P45 folgen konkretem Integrations-, Memory-, Verifikations- oder Identitätsbedarf. Mobile bleibt zurückgestellt.

P02, P11, P26, P27 und P46 sowie G5 werden im [Leitplanken-Plan](basic-leitplanken.md) geführt. Sie bilden keine eigene Etappe der Feature-Reihenfolge; notwendige technische Gates gelten weiterhin vor Aktivierung. P18 bezeichnet P18a/P18b; P38 umfasst P38a/P38b/P38c. **P49a/P49b** präzisieren den gelieferten Basisumfang, den funktional gelieferten Factories-first-Arbeitsplatz und dessen aktuelle Gestaltungsüberarbeitung innerhalb der bisherigen P49-ID.

### Anschluss an die v3-Parallelitätslieferung: Definitionsmodell v4

Das abgestimmte [modulare Modell im Definitionsrepository](https://github.com/niklaskastning/foundry-definitions/blob/main/docs/definition-model.md) ([Spezifikations-PR #3](https://github.com/niklaskastning/foundry-definitions/pull/3)) bleibt die gemeinsame Grundlage für P28/P52/P29. Der v4-Schnitt ist implementiert: getrennte Ressourcenregistrierung, vollständige gehashte Skilltrees, additive Workflow-/Step-Erweiterungen, explizite Migrationsexporte, strukturierte Resultate, typisierte Conditions und persistente Swarm-/Loop-Zustände auf dem bestehenden Automation-PostgreSQL. Technisches Retry und fachliche Review/Fix-Iteration besitzen getrennte Identitäten und Budgets; `test`-Nodes zählen wegen ihres physischen Workerstarts ebenfalls gegen Ausführungs- und Parallelitätslimits.

Die Workeranbindung ist Codex-spezifisch. MCP stdio/Streamable HTTP benötigt eine aktivierte Factory-Bindung, aktuelle Secret-Referenzen und nachweisbar durchgesetzte exakte Toolrechte. HTTP-Auth verwendet zunächst Bearer-Referenzen; zusätzliche Provider/OAuth-Flows werden nicht mitbehauptet. Die Spezifikation besitzt die konkreten Bundle-, Graph-, Resultat- und Budgetgrenzen. Pollende Runansichten verwenden kompakte Node-Seiten mit gesonderten Details; die UI unterscheidet Definition, Herkunft, gepinnten Attempt und Iterationszustand.

**Linux/Codex und Web nativ abgenommen; ausdrückliche v4-Aktivierung möglich.** Der geprüfte Main-/Worker-Stand ist `73736699a4910bb2cf2ccad22c2a52050e00acc0`, Main-Image `sha256:740692707d4cc74441f9075002356b384083b3e26fd5b3a9837cea7d013831ef`, Instanz-/Automation-Schema 8/11. [Foundry PR #72](https://github.com/niklaskastning/foundry/pull/72) und [Definitions-PR #5](https://github.com/niklaskastning/foundry-definitions/pull/5) besitzen die Abnahmebelege.

Der native Swarm belegte beide gleichzeitig an MCP wartenden Writer, getrennte Workspaces und die explizite Integration beider Git-Checkpoints mit Marker 1 trotz aktiver Revision mit Marker 2. Der Main-Neustart erhielt den gepinnten Stand. Delivery-Run `559833db-d503-4ba2-80ea-8786684fbaf6` endete nach ausdrücklicher UI-Freigabe erfolgreich: vier Luna-Turns mit `medium`, zwei fachliche Iterationen und kein technischer Retry. Der erste Writer-Checkpoint enthielt `draft`, der zweite erbte exakt diesen Stand und enthielt `approved`; die Reviews lasen diese Dateien und `until` wurde in Iteration 2 wahr. Das ausgeführte Skillskript entsprach dem gepinnten Inhalts-Hash. Der Webpfad einschließlich T3-Verbindung und Handoff-Rückkehr ohne zusätzlichen Providerturn ist mit bestätigtem zentralen Archiv geprüft; die pausierte Fortsetzung wurde anschließend beendet.

Strukturierte JSON-Resultate allein belegen keine Dateiarbeit. Der deterministische Skillskript-/Git-Nachweis prüft die tatsächliche Ausführung, keine allgemeine Modellqualität. Loader-/Validator-, PostgreSQL- und Adaptertests ergänzen ungültige Resultate, Conditions, Teilfehler, Retry/Restart/Cancel, Budgets und Rückwärtskompatibilität; sie bleiben von den nativen Nachweisen getrennt. Windows-Nativ und öffentliches SSO haben weiterhin eigene offene Gates; Mobile bleibt zurückgestellt. Der allgemeine Beispielsatz `factories/modular-review` ist validatorgeprüft, während `factories/v4-native` die konkrete Abnahmefixture enthält.

V1/v2/v3 werden weder umgedeutet noch automatisch migriert. V3 bleibt die kompatible Grundlage für statische DAGs und seine bisherige Reparatursemantik; ein v4-Migrationsexport muss insbesondere die neue Einstufung retryfähiger technischer Fehler prüfen. Reproduzierbare Sandboxes P34–40 bleiben die nächste eigenständige große Etappe. Keine zweite Definitionssprache und keine Sandboxplattform in diesen Schnitt aufnehmen.

### Abnahme der aktuellen UI-Lieferung

Der funktionale Web-/Linux-/Codex-Nachweis aus PR #67/#72 bleibt bestehen. [PR #74](https://github.com/niklaskastning/foundry/pull/74) belegt die erneute P49b-Prüfung am Implementierungsstand `6087f1e2ec8e2a137012a1aedac541baa402686e`: echte VPS-Main-Daten, eigener approval-only v4-Run mit zwei revisionsgebundenen Freigaben und ohne Providerstart/Writer, T3-Gateway-Threadlink mit Rückkehr, Reload und Browser-Zurück. Geprüft wurden außerdem Filter/Pagination, 390/480/1440px in Hell/Dunkel, Offline-Wiederverbindung über den eigenen Prüfproxy sowie eine echte Sitzung mit Leserechten. Das unabhängige Review ist abgeschlossen; seine vier Befunde sind behoben. Screenshots, automatisierte Nachweise, finale Artefakt-/CI-Ergebnisse und Deploymentrevision bleiben im PR als Auslieferungsnachweis. Native Windows-UI und öffentliches SSO sind damit nicht abgenommen; die menschliche Designabnahme bleibt offen.

Für die Lieferung gelten folgende Kriterien; geprüfte technische Bedienbarkeit ersetzt keine menschliche Designbestätigung:

1. Vorher-/Nachhercaptures repräsentativer Hauptansichten auf echten laufenden Daten: Home/Factory, Auftrag, Agenten/Skills/MCP, Workflows/Definition, Run mit v4-Iteration, Inbox, Ressourcen und Einstieg/Settings. Pro Ansicht Aufgabe, konkreten Bruch und Änderung festhalten; funktionierende Bereiche bewahren.
2. Zusammenhängend Home → Factory → Auftrag → v4-Run/Iteration → revisionsgebundene Inboxentscheidung → T3 → derselbe Auftrag bedienen. Eigene kostenlose/approval-only Daten für Mutationen; fremde Abnahmeruns nur lesen. Ergebnisse und Evidence öffnen, tatsächlichen Worker/Checkpoint und gepinnte Ressourcen nachvollziehen.
3. Reload, Browser-Zurück, Deep-Links, Filter und Pagination erhalten den Kontext. Leer-/Lade-/Fehler-/Offline-/Rechtefälle sowie 390–480px und breite Desktopdarstellung in Hell/Dunkel prüfen; Tastaturfokus und Labels erhalten. Keine Erfolgssuggestion für fehlgeschlagene oder unvollständige Ausführung.
4. Factories bleibt erster Einstieg ohne Chatflash während Auth-/Capability-Laden. Chats und direkte Threadlinks sowie standalone T3 bleiben funktionsfähig. Web-/Desktop-Shell und gemeinsame Entry Points werden geprüft; native Windows-Laufzeit und öffentliches SSO bleiben eigene offene Gates.
5. Unabhängiges Review der integrierten UI, fokussierte Logik-/Navigation-/Permissionstests und tatsächliches Deployment mit Revisionsnachweis abschließen. Ein funktionaler Testpass oder Fixture-Demo ersetzt keine Gestaltungsprüfung. Die menschliche Designabnahme wird nur nach ausdrücklicher Nutzerbestätigung geschlossen.

Nicht Teil dieser UI-Lieferung sind ein freier Workflow-Canvas, neue Provider-Laufzeiten, automatische Modellrouter, neue Qualitätsmetriken oder leere Sandbox-Menüs. Die parallele P34–P40-Lieferung besitzt eigene Funktions- und Abnahmegrenzen; eine UI-Integration behauptet keine noch fehlende Sandboxfähigkeit.

## Funktionale Meilensteine

| Meilenstein                        | Nutzbares Ergebnis                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 · Instanzeinstieg               | Web und Windows: Instanz wählen, anmelden, wechseln und entfernen; Access und native Anmeldung separat.                                                                   |
| G2 · Device-Zugriff                | Zwei Clients nutzen Device-Katalog, Threads, Terminal, Dateien, Diffs und Anhänge über Main.                                                                              |
| G3 · Worker                        | Agentenauftrag ohne Eltern-Agenten starten, verfolgen, abbrechen und Ergebnis öffnen.                                                                                     |
| G4 · Workflow-MVP                  | Definition bearbeiten/importieren → manuell oder über GitHub/Zeitplan starten → Analyse, Änderung, Test und Freigabe → PR; Inbox und Ergebnisse bedienen.                 |
| G6 · Wiederverwendung / Multi-Repo | Agenten/Skills wiederverwenden, Arbeit aufteilen und Ergebnisse je Repository öffnen; Multi-Repo-Step erst mit P31.                                                       |
| G7 · Mehrere Worker                | Feste Ziele und Pools wählen und Aufträge verschiedenen Workern zuordnen.                                                                                                 |
| G8 · Sandboxes                     | Dasselbe Profil interaktiv und im Workflow nutzen, Sandbox löschen und Arbeit aus dem Archiv fortsetzen.                                                                  |
| G9 · Connectoren / Memory          | Gewählten Connector nutzen beziehungsweise Wissen speichern, suchen und löschen.                                                                                          |
| G10 · Identität / Gruppen          | Gewählten Anmeldeanbieter verbinden oder Device-Gruppen gemeinsam nutzen.                                                                                                 |
| G11 · Factory als Produkt          | Lokale Definition ausdrücklich nach Git übernehmen; Git-Änderung und ungültigen Folgecommit prüfen; gepinnte Revision am Run und Inbox-Entscheidung nachvollziehen.       |
| G12 · Zusammenarbeit               | Auftrag mit T3-Übernahme und Rückgabe bis zum PR über UI/API/MCP bearbeiten; Maschinenzugang separat nachweisen. Koordinator P50 nur bei Aktivierung zusätzlich abnehmen. |
| G13 · Qualitätsfunktionen          | Dashboard öffnen, Runs bewerten, Benchmarks vergleichen und Verbesserungsvorschläge übernehmen.                                                                           |
| G14 · Weitere Einsatzfälle         | Jeden zusätzlichen Connector und jede Browser-/Incident-Vorlage einzeln nutzen.                                                                                           |

## Instanzeinstieg und Devices

### P01 · Instanzerkennung

Instanzen eindeutig erkennen und verfügbare Funktionen an Clients melden.

### P03 · Anmeldung über Access

Über Cloudflare Access bei Foundry anmelden, die Sitzung erneuern und sich abmelden.

### P03N · Native Foundry-Anmeldung ohne Cloudflare Access

Foundry ohne Cloudflare oder externen Identitätsanbieter einrichten und nutzen: Erstanmeldung, Kontoverwaltung, Login/Logout und Wechsel des Anmeldeverfahrens.

### P04 · Windows-Anmeldung über Access

Access-Anmeldung im Windows-Client über den Systembrowser ermöglichen und für die anschließende Instanzverbindung verwenden.

### P05 · Instanz-URL und Onboarding in Web/Windows

Instanz-URL eingeben, anmelden, Instanzen wechseln und gespeicherte Instanzen entfernen. Anmelde- und Verbindungszustände verständlich anzeigen.

### P06 · Device-Registrierung und einmaliges Enrollment

Devices an einer Instanz registrieren und wieder trennen.

### P07 · Ausgehender Device-Kanal

Devices verbinden sich ausgehend mit Main und melden ihren Verbindungsstatus.

### P08 · HTTP-Zugriff über Main

HTTP-Funktionen eines registrierten Devices über die gemeinsame Main-Domain erreichen.

### P09 · WebSocket-, Thread- und Terminaltransport

Live-Threads und Terminalverbindungen über Main bedienen.

### P10 · Dateien, Diffs und Attachments über Gateway

Dateien, Diffs und Anhänge über Main öffnen und herunterladen; unterbrochene Übertragungen fortsetzen.

### P12 · Device-Katalog und interaktive Auswahl

Devices mit Online-/Offline-Status anzeigen und für bestehende Projekt- und Threadansichten auswählen, registrieren oder trennen.

## Worker

### P13 · Dauerhafter Linux-Worker

Einen dauerhaften Linux-Worker für Agenten und Entwicklungswerkzeuge betreiben, starten und stoppen.

### P14 · Provider-Bereitschaft und Codex-Bindung

Codex auf dem Worker einrichten und anmelden; Verbindung, Provider-Bereitschaft und freie Kapazität getrennt anzeigen.

### P15 · Worker-Aufträge starten

Agentenarbeit direkt als Worker-Auftrag starten, ohne einen übergeordneten Agenten-Thread zu benötigen.

### P16 · Follow, Ergebnisfinalisierung und Cancel

Worker-Aufträge verfolgen, Ergebnisse einschließlich Checkpoint lesen und laufende Arbeit abbrechen.

### P17 · Workspace-Belegung für manuelle und automatisierte Arbeit

Checkouts und Worktrees für manuelle sowie automatisierte Arbeit anlegen, zuordnen und wieder freigeben.

### P14Z · Zentrale Kontoverbindungen

Provider- und externe Kontoverbindungen einmal in Foundry einrichten, prüfen, erneuern und trennen. Neue Worker übernehmen ausgewählte Verbindungen ohne separate Anmeldung. **P14Za** liefert Codex für dauerhafte Worker; **P14Zb** ergänzt weitere Provider einzeln. GitHub folgt über P23, Azure DevOps über P41, Sandboxes über P37 und MCP-Verbindungen über P52.

## Factory-MVP

### P18a · Factory und beständiger Auftrag

Factories und beständige Aufträge mit Quelle, Zustand und Repository-Bezug verwalten. Factories archivieren und wiederherstellen; Auftragsabschluss und einzelne Run-Ergebnisse getrennt führen.

### P18b · Workflow-Versionen und Runs

Workflow-Versionen mit sequenziellen Agent-, Test-, Freigabe- und Publish-Schritten definieren. Runs behalten ihre gestartete Version und bleiben dem Auftrag zugeordnet.

### P47 · Kanonische Definition und lokale Validierung

Factories als kanonische `factory.yaml` mit Workflow-Dateien importieren, exportieren, validieren und aktivieren. Formulare und Dateien verwenden dasselbe Format; Fehler werden an Datei und Feld angezeigt.

### P38a · Zentrale Attachment- und Artefaktpersistenz

Anhänge und Ergebnisartefakte zentral speichern. Web und Windows öffnen dieselben Referenzen unabhängig vom ursprünglichen Browser oder Worker.

### P38b · Fortlaufendes zentrales Thread-Archiv

Manuelle und Workflow-Threads zentral archivieren und in der vorhandenen Timeline lesen. Herkunft, Anhänge, letzter übertragener Stand und Vollständigkeit anzeigen, auch wenn der Worker offline ist.

### P19 · Sequenzielle Workflow-Ausführung

Sequenzielle Workflows auf einem ausgewählten Worker ausführen und nach Abschluss eines Schritts den nächsten starten.

### P20 · Run-Steuerung und menschliche Freigabe

Runs pausieren, fortsetzen, abbrechen und erneut versuchen. Menschliche Freigaben und Antworten dem jeweiligen Ergebnisstand zuordnen.

### P21 · Manueller Start und Run-Ansicht

Factory und Auftrag auswählen, Definitionen übergangsweise im Formular bearbeiten/importieren und als Snapshot aktivieren, Runs manuell starten sowie Schritte, Versuche, Ergebnisse und verlinkte Threads ansehen. Mit P48 werden Definitionen verbindlich über Git gepflegt.

### P49 · Factory-Navigation und persönliche Inbox

**P49a – implementierter Basisschnitt:** Einstiege in Sidebar, Settings und Command Palette; Factory-/Run-Listen und persönliche Inbox für Fragen, Antworten, Reviews, Blocker und Fehler. Gelesen, erledigt und rückgängig sind getrennt von fachlichen Entscheidungen.

**P49b – funktionaler Factories-first-Stand geliefert, erneute Gestaltung aktuell:** PR #67 liefert Factory-Home, globale und kontextuelle Navigation sowie beständige URLs; PR #72 bestätigt den erweiterten v4-Webdurchstich. Die erneute Nutzeranforderung betrifft die produktive Bedienbarkeit aller zentralen Ansichten. Die aktuelle Umsetzung priorisiert Arbeit, Entscheidungen und Ergebnisse in kompakten Listen, trennt Workflows in einen eigenen Tab und legt wirksame Konfiguration/Herkunft in Details. Runansichten unterscheiden Swarmzweige, fachliche Reviewrunden und technische Retries; Inbox-Done bleibt von Freigaben getrennt, T3 sekundärer Arbeitskontext. Automatisierte Prüfungen, Browserpass und unabhängiges Review sind in [PR #74](https://github.com/niklaskastning/foundry/pull/74) belegt; der PR führt auch den finalen Auslieferungsnachweis. Die menschliche Designabnahme bleibt offen. Die Kriterien oben prüfen echte Daten, Navigation, Zustände, Themes, schmale/weite Breite und Accessibility. Keine neue Workflow-Steuerung oder Metrikdefinition in der UI; die Zielstruktur steht in Architekturabschnitt 12, Kennzahlen gehören P54.

### P22 · GitHub-Polling mit persistentem Eingang

GitHub-Issues mit ausgewähltem Label abrufen und daraus Workflow-Aufträge erzeugen.

### P23 · GitHub-PRs veröffentlichen

Workflow-Ergebnisse nach Freigabe über einen zentral eingerichteten GitHub-App-Zugang als Pull Request veröffentlichen und den PR dem Auftrag zuordnen.

### P24 · Zeitplan-Trigger

Workflows nach Zeitplan und Zeitzone starten; Verhalten bei verpassten oder überlappenden Terminen einstellen.

## Git-Verwaltung

### P48 · Git als Definitions-Owner

Das separate Definitions-Repository an Factory, Pfad und Branch binden und Änderungen synchronisieren. Quelle, Diff, aktive Revision und Fehler anzeigen; manuelle Testdefinitionen mit Driftabgleich übernehmen und frühere Git-Revisionen aktivieren. Git ist der dauerhafte Owner, kein Parallelmodus zu App-Definitionen. Menschen, autorisierte Agenten und ein späterer UI-Editor ändern dieselben Dateien über PRs. Betriebsbindungen, Trigger und Run-Entscheidungen bleiben in der App bedienbar. Aktivierte Snapshots bleiben für laufende Runs und Historie erhalten.

## Zusammenarbeit und wiederverwendbare Agenten

### P51 · Auftrag in T3 übernehmen und zurückgeben

Einen Auftrag in T3 übernehmen, im zugehörigen Thread/Workspace bearbeiten und mit neuer Revision zurückgeben. Alternativbranch und beidseitige Links anbieten; bei Bedarf aus dem archivierten Stand einen neuen Workspace erstellen.

### P58 · Externe API und Factory-MCP

**P58a** stellt eine versionierte HTTP-API mit maschinenlesbarem Vertrag bereit.
Der erste Schnitt verwendet die vorhandenen Foundry-/T3-Benutzersitzungen und
dieselben Services für Suche, Start, Steuerung, Übergabe, Inbox und Konfiguration.
Ein gesonderter Schnitt ergänzt eigenständige Maschinen-Credentials mit Ausgabe,
Ablauf und Widerruf für Factory-begrenzte Leseabfragen. Maschinen-Start und -Steuerung
bleiben offen; interaktive Cookies sind kein CI-Zugang. Der öffentliche Zugang durch
vorgeschaltetes Access benötigt weiterhin eine eigene Betriebsabnahme.
**P58b** ergänzt Factory-MCP für Suche, Start, Steuerung, Übergabe und
Definitionsvalidierung. Vorhandene T3-MCP-Tokens besitzen keine Foundry-Identität
und dürfen nicht als solche verwendet werden. MCP-Instruktionsevals gehören zur
Abnahme von P58b, unabhängig von der späteren Eval-Produktoberfläche.

### P28 · Versionierter Agent- und Skill-Katalog

Agenten und Skills im Definitionsformat versionieren, in mehreren Workflows wiederverwenden und die verwendete Version am Run festhalten. Agent-Steps referenzieren Rollen; Aktivierung validiert Referenzen, Ausführung löst Instruktionen und Skills unveränderlich auf. Bestehende Prompt-Schritte bleiben kompatibel.

### P52 · Agentenressourcen und Ausführungseinstellungen

**P52a** verbindet die versionierten Rollen mit tatsächlich unterstützten Worker-Fähigkeiten und zeigt Agenteninstruktionen, Automationen, Version und Einstellungen. MCP-, Secret- und Connector-Ressourcen an Factory und Rolle binden; Provider, Modell, Optionen sowie Defaults/Overrides wählen. Die wirksame Step-Konfiguration muss bis zum Worker durchgereicht und am Run sichtbar sein; ein UI-Selektor allein erfüllt dieses Paket nicht. **P52b** ergänzt Modell-Routing nach Aufgabenklasse mit sichtbarer aufgelöster Auswahl.

### P29 · Fan-out/Join und begrenzte Reparaturschleifen

Workflow-Arbeit parallel aufteilen und wieder zusammenführen. Join-Verhalten, Umgang mit Teilfehlern, Parallelität und Anzahl der Reparaturdurchläufe konfigurieren. Abnahme mit mindestens zwei gleichzeitig ausführbaren, voneinander getrennten Workspaces; Kapazität und Worker-Auswahl aus P32/P33 einbeziehen.

### P50 · Optionaler Koordinator als Agentenrolle

Optionalen Koordinator-Dialog am Auftrag ergänzen: Plan- und Revisionsvorschläge erstellen und Workflow-Stufen auswählen. Die Rolle läuft auf einem Worker.

### P53 · Vorlagen für Triage und PR-Review

**P53a** liefert eine Issue-Triage-Vorlage, **P53b** eine PR-Review-Vorlage. Kommentare, Rückfragen und Ergebnisse bleiben am GitHub-Ursprungsobjekt und zugehörigen Auftrag verbunden.

### P30 · Mehrere Repositories pro Auftrag

Einen Auftrag über mehrere Repositories mit eigenen Workspaces, Revisionen, Ergebnissen und PRs ausführen.

### P31 · Mehrere Repositories in einem Agent-Step

Mehrere Repository-Checkouts in einem Agentenschritt nutzen; gemeinsame Diff-, Checkpoint- und Ergebnisansicht anbieten.

## Qualitätsfunktionen

### P54 · Factory-Dashboard und Produktmetriken

**P54a** ordnet Nutzungs- und PR-Aktivität den Runs zu. **P54b** zeigt ein Factory-Dashboard mit Zeitraum, Qualität, PR-Aktivität, Zeitanteilen, Autonomie, verfügbaren Limits und Kostenschätzungen samt Drill-down.

### P55 · Versionierte Scorers und Bewertungshistorie

Bewertungskriterien, Judge-Konfiguration, Klassen, Schwellen und Sampling versionieren. Runs automatisch nach Abschluss oder manuell bewerten; Ergebnisse am Run und in einer Scorer-Historie anzeigen.

### P56 · Wiederholbare Benchmarks

Benchmark-Suites aus vorhandenen Runs oder manuellen Aufgaben erstellen, Repo-Ausgangsstände und Konfigurationsvarianten wählen, Trials starten/stoppen und Qualität, Zeit sowie Kosten vergleichen.

### P57 · Belegte Verbesserungsvorschläge

Als aktivierbare Produktfunktion Beobachtungen und Evals auswerten und Vorschlags-PRs erzeugen: Factory-Workflows, Prompts, Skills und Evaluationsdefinitionen im gemeinsamen Definitionsrepository, Anwendungscode im jeweiligen Arbeitsrepository. Menschen und Agenten nutzen dieselben Dateien und denselben Review-Weg. Manuell starten und deaktivieren; bereits bearbeitete Fehlergruppen erkennen.

## Mehrere Worker und Sandboxes

### P32 · Kapazitäten und explizite Zielauswahl

Feste Worker oder Worker-Pools für Aufträge auswählen, Kapazitäten anzeigen und Worker für neue Arbeit pausieren.

### P33 · Mehrere dauerhafte Worker

Aufträge auf mehreren dauerhaften Workern ausführen und die Gerätezuordnung im Run anzeigen.

### P34 · Sandbox-Profile und Allocation-Service

Sandbox-Profile versionieren und Sandboxes für Benutzer oder Workflow-Runs anfordern; Bereitstellungszustände anzeigen.

### P35 · Linux-Container-Sandboxes

Linux-Container als Sandbox anlegen und stoppen; einen OCI-Adapter an die Bereitstellung anbinden.

### P36 · Setup-Profil und Sandbox-Enrollment

Sandbox als Environment registrieren und mit ausgewählten Checkouts, Tools, Skills und Setup-Befehlen vorbereiten; Setupstatus anzeigen.

### P37 · Codex-Verbindung für Sandboxes

Die zentrale Codex-Verbindung auch in neu bereitgestellten Sandboxes verwenden.

### P38c · Sandbox abschließen und löschen

Sandbox-Arbeit mit Thread, Anhängen und Git-Stand abschließen und anschließend die Sandbox löschen. Archivierte Ergebnisse bleiben verfügbar; Lebensdauer und automatische Bereinigung unterstützen.

### P39 · Interaktive Sandbox im Client

Sandboxes im Client anfordern, Setup verfolgen, öffnen, verlängern und löschen. Danach das Archiv öffnen oder auf einem neuen Environment weiterarbeiten.

### P40 · Sandbox-Ausführung im Workflow

Sandbox-Ausführung an Workflow-Runs oder Versuche binden und Bereitstellung, Wartezustände sowie Abbruch in der Run-Steuerung anzeigen.

## Weitere Eingänge, Memory und Vorlagen

### P25 · GitHub-Webhooks

GitHub-Ereignisse zusätzlich zum Polling per Webhook empfangen und vorhandenen Aufträgen zuordnen.

### P41 · Azure-DevOps-Connector

Azure-DevOps-Work-Items als Quelle für Workflow-Aufträge anbinden.

### P42 · Jira/JSM-Connector

Für den konkreten Bedarf Jira Cloud oder Data Center samt JSM-Feldern als Auftragsquelle anbinden.

### P43 · Repository- und Workflow-Memory

Repository- und Workflow-Wissen mit Version, Herkunft und Geltungsbereich speichern, suchen, freigeben und löschen.

### P59 · Zusätzliche Arbeitsquellen

Weitere Arbeitsquellen einzeln anbinden: **P59a** generische Webhooks mit Payload-Filtern und Zustelllog, **P59b** GitLab, **P59c** Linear, **P59d** Slack, **P59e** Microsoft Teams. Aufträge, Rückfragen und Ergebnislinks mit dem Ursprungsort verbinden.

### P60 · Browser-Verifikation und Incident-Vorlagen

**P60a** lässt einen Browser-Verifier einen Teststand bedienen und Screenshots/Testberichte zum Auftrag liefern. **P60b** verbindet eingehende Betriebsalarme, Diagnose und Fix-Vorschläge in einer Incident-Vorlage.

## Optionale Anmeldung und Device-Gruppen

### P44 · Optionaler Clerk/OIDC-Identitätsadapter

Optional einen Clerk-/OIDC-Anbieter mit der bestehenden Foundry-Benutzeridentität verbinden, wechseln und wieder trennen.

### P45 · Teamzugriff auf Device-Gruppen

Mitgliedschaften und Device-Gruppen für gemeinsam genutzte Devices verwalten. Dieses Paket umfasst noch keine Teamverwaltung für sämtliche Foundry-Objekte.
