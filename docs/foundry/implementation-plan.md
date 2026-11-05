# Foundry – Implementierungsplan für Features und Funktionen

Stand: 5. November 2026. Dieser Plan beschreibt Produktfunktionen, ihre Reihenfolge und funktionale Abnahmen. Sicherheits-, Betriebs-, Backup-, Performance- und technische Prüfthemen stehen im separaten [Plan für Basic-Leitplanken](basic-leitplanken.md). Architektur und Deployment bleiben die zugehörigen Entwürfe. Paket-IDs P01–P60 bleiben erhalten und sind keine GitHub-PR-Nummern.

## Erledigte Implementierung und verbleibende Abnahmen

- [x] **P01, P03–P17 (Access-Modus, ohne P03N/P14Z):** Instanzeinstieg über Access, Device-Katalog, Gateway und dauerhafter Linux-Worker sind integriert. Web/Windows können denselben Worker nutzen. Funktionaler G3-Abschluss bestätigt ([#29](https://github.com/niklaskastning/foundry/pull/29), [#45](https://github.com/niklaskastning/foundry/pull/45)).
- [x] **P18a/P18b, P47:** Factories, Aufträge, Workflow-Versionen und kanonischer Definitionsimport/-export integriert ([#36](https://github.com/niklaskastning/foundry/pull/36), [#46](https://github.com/niklaskastning/foundry/pull/46), [#47](https://github.com/niklaskastning/foundry/pull/47)).
- [x] **P38a/P38b:** Zentrale Anhänge und fortlaufende Thread-Archive integriert und auf der Entwicklungs-VPS aktiviert ([#48](https://github.com/niklaskastning/foundry/pull/48), [#50](https://github.com/niklaskastning/foundry/pull/50)).
- [x] **P19:** Sequenzieller Workflow-Dispatch integriert ([#51](https://github.com/niklaskastning/foundry/pull/51)).
- [x] **P20/P21/P49:** Run-Steuerung, manueller Definitions-/Startfluss und persönliche Inbox integriert; Automation auf der Entwicklungs-VPS aktiviert ([#52](https://github.com/niklaskastning/foundry/pull/52)).
- [x] **P22/P23/P24 – Implementierung:** GitHub-Polling, PR-Publishing und Zeitpläne implementiert. Die reale GitHub-App-Verbindung und ein betreuter nativer Issue-bis-PR-Workflow sind bestätigt ([#56](https://github.com/niklaskastning/foundry/pull/56)).
- [ ] **Funktionale Restabnahmen:** Instanzwechsel/Entfernen mit zwei realen Instanzen, Worker auf zweiter Maschine, Wiederverbindung beider Clients und Wiederaufnahme laufender Aufträge. Windows-Laufzeit und Bedienung der Factory bleiben offen; der bestätigte native G4-Durchstich schließt diese Restabnahmen nicht.
- [ ] **Produktlücken:** Native Foundry-Anmeldung P03N, automatischer Katalog-Erstabruf, Einstieg ohne getrenntes T3-Pairing und Windows-Downloads im Foundry-Einstieg.
- [ ] **Zentrale Verbindungen P14Z:** Provider-, Source-Control- und MCP-Konten einmal in Foundry einrichten und auf Workern/Sandboxes nutzen.
- [ ] **Git-Verwaltung P48:** Quellbindung, lesende Synchronisierung, Driftabgleich, dauerhafte Git-Ownership, explizite Aktivierung/Rollback und Herkunftsansichten sind implementiert. Der isolierte PostgreSQL-Nachweis umfasst Import → Git-Änderung → ungültigen Folgecommit → Run und Inbox-Entscheidung mit erhaltenen alten Revisionen. Live-Anbindung, gemeinsamer Browserpass und Deployment sind noch abzuschließen.

Der zentrale Benutzerzugang ist noch ein Übergangsstand: Foundry-Anmeldung und eine separat autorisierte Main-T3-Sitzung werden gemeinsam geprüft. Worker-Zugriff benötigt kein eigenes Geräte-Pairing, reicht aber bisher nur die freigegebenen Thread-, Terminal- und Dateileserechte weiter; `settings:write` gehört noch nicht zum Gateway-Vertrag. Eine Anmeldung mit vollständig daraus abgeleiteten zentralen Benutzerrechten ist damit noch nicht abgenommen. Dies betrifft den Benutzerzugang, nicht die getrennte Provider-Autorisierung aus P14Z.

Die ausführlichen bisherigen Prüf- und Deploymentnachweise sind nach [Basic-Leitplanken](basic-leitplanken.md#bestehende-nachweise-und-offene-technische-abnahmen) verschoben. Offene Abnahmen werden durch diese Aufteilung nicht als erledigt markiert.

## Umsetzungsreihenfolge ab P17

1. **Worker:** P17 / G3 abschließen; die Basis P01–P16 ist integriert.
2. **Factory-MVP:** P18a → P18b → P47 → P38a → P38b → P19 → P20 → P21 → P49 → P22 → P23 → P24 / G4. P22/P24 können nach P19 unabhängig vom UI-Anschluss entstehen.
3. **Git-Verwaltung:** P48 / G11 als nächster Feature-Ausbau.
4. **Zusammenarbeit:** P51 → P58; P28 → P52; P29 → P50 → P53; danach P30/P31 / G6 und G12. P50 bleibt optional.
5. **Qualitätsfunktionen:** P54 → P55 → P56 → P57 / G13. Dashboard, Scorers, Benchmarks und Verbesserungsvorschläge sind Produktfunktionen; technische Performance-Optimierung steht im separaten Plan.
6. **Weitere Worker und Sandboxes:** P14Za vor zentral verbundenen zusätzlichen Workern; P32/P33 / G7, danach P34–P40 / G8. Dieser Pfad kann nach dem Factory-MVP parallel zur Zusammenarbeit entstehen.
7. **Weitere Integrationen:** P25, P41–P43, P59/P60 / G9 und G14 nach Bedarf; P44/P45 / G10 für zusätzliche Anmeldeanbieter und Device-Gruppen.

P02, P11, P26, P27 und P46 sowie G5 werden im [Leitplanken-Plan](basic-leitplanken.md) geführt. Sie bilden keine eigene Etappe der Feature-Reihenfolge. P18 bezeichnet weiterhin P18a/P18b; P38 umfasst P38a/P38b/P38c. Bestehende technische Voraussetzungen stehen beim jeweiligen Paket im separaten Plan.

## Funktionale Meilensteine

| Meilenstein                        | Nutzbares Ergebnis                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 · Instanzeinstieg               | Web und Windows: Instanz wählen, anmelden, wechseln und entfernen; Access und native Anmeldung separat.                                                             |
| G2 · Device-Zugriff                | Zwei Clients nutzen Device-Katalog, Threads, Terminal, Dateien, Diffs und Anhänge über Main.                                                                        |
| G3 · Worker                        | Agentenauftrag ohne Eltern-Agenten starten, verfolgen, abbrechen und Ergebnis öffnen.                                                                               |
| G4 · Workflow-MVP                  | Definition bearbeiten/importieren → manuell oder über GitHub/Zeitplan starten → Analyse, Änderung, Test und Freigabe → PR; Inbox und Ergebnisse bedienen.           |
| G6 · Wiederverwendung / Multi-Repo | Agenten/Skills wiederverwenden, Arbeit aufteilen und Ergebnisse je Repository öffnen; Multi-Repo-Step erst mit P31.                                                 |
| G7 · Mehrere Worker                | Feste Ziele und Pools wählen und Aufträge verschiedenen Workern zuordnen.                                                                                           |
| G8 · Sandboxes                     | Dasselbe Profil interaktiv und im Workflow nutzen, Sandbox löschen und Arbeit aus dem Archiv fortsetzen.                                                            |
| G9 · Connectoren / Memory          | Gewählten Connector nutzen beziehungsweise Wissen speichern, suchen und löschen.                                                                                    |
| G10 · Identität / Gruppen          | Gewählten Anmeldeanbieter verbinden oder Device-Gruppen gemeinsam nutzen.                                                                                           |
| G11 · Factory als Produkt          | Lokale Definition ausdrücklich nach Git übernehmen; Git-Änderung und ungültigen Folgecommit prüfen; gepinnte Revision am Run und Inbox-Entscheidung nachvollziehen. |
| G12 · Zusammenarbeit               | Auftrag über Koordinator, T3-Übernahme und Rückgabe bis zum PR über UI/API/MCP bearbeiten.                                                                          |
| G13 · Qualitätsfunktionen          | Dashboard öffnen, Runs bewerten, Benchmarks vergleichen und Verbesserungsvorschläge übernehmen.                                                                     |
| G14 · Weitere Einsatzfälle         | Jeden zusätzlichen Connector und jede Browser-/Incident-Vorlage einzeln nutzen.                                                                                     |

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

Globale und Factory-bezogene Navigation mit Listenfiltern anbieten. Persönliche Inbox für Fragen, Antworten, Reviews, Blocker und Fehler mit Links zum Auftrag, Run und Thread; gelesen, erledigt und rückgängig getrennt bedienen.

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

**P58a** stellt eine externe HTTP-API mit maschinenlesbarem Vertrag bereit. **P58b** ergänzt Factory-MCP für Suche, Start, Steuerung, Übergabe und Definitionsvalidierung.

### P28 · Versionierter Agent- und Skill-Katalog

Agenten und Skills im Definitionsformat versionieren, auswählen und die verwendete Version am Run festhalten.

### P52 · Agentenressourcen und Ausführungseinstellungen

**P52a** zeigt Agenteninstruktionen, Automationen, Version und Einstellungen. MCP-, Secret- und Connector-Ressourcen an Factory und Rolle binden; Provider, Modell, Optionen sowie Defaults/Overrides wählen. **P52b** ergänzt Modell-Routing nach Aufgabenklasse mit sichtbarer aufgelöster Auswahl.

### P29 · Fan-out/Join und begrenzte Reparaturschleifen

Workflow-Arbeit parallel aufteilen und wieder zusammenführen. Join-Verhalten, Umgang mit Teilfehlern, Parallelität und Anzahl der Reparaturdurchläufe konfigurieren.

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
