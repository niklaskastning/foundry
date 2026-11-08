# Foundry – einzeln vergebbare Arbeitspakete

Stand: 8. November 2026. Grundlage: [vollständiges Feedback F01–F34](../.plans/recording-2026-11-08/feedback.md) einschließlich Screenshots und Main-Abgleich zu `dfeb62c511533eef46fb411d22c36c18d7d34b8a`. Vor Umsetzung aktuellen Main-Stand und laufende PRs prüfen. Der Abgleich ist keine Aussage über den aktuell deployten Stand.

Dieses Dokument strukturiert den Arbeitsumfang für die Vergabe an einzelne Agents. Es implementiert nichts und startet keine Agents. Jeder Auftrag besteht aus den zentralen Vorgaben, genau einem Paket und den dort genannten Feedbackstellen. Die Originalquelle bewahrt Details, Zeitmarken und Referenzbilder. Die Abnahmekriterien hier konkretisieren den Vorschlag; offene Produktentscheidungen sind ausdrücklich benannt.

## Zentrale Vorgaben für alle Pakete

### Entwicklungsdaten, Builds und Updater

**Wir befinden uns in der Entwicklungsphase und haben in dieser Foundry-Entwicklungsumgebung keine Produktivdaten. Sicherungen von Foundry-Anwendungsdaten oder bisherigen Builds sind aktuell nicht erforderlich.** Taskbezogene Datenbank-/Volume-Resets sind erlaubt; Ziel vorher prüfen und den Reset melden. Keine zusätzlichen Backups, Build-Archive oder zeitaufwendigen Recovery-Kopien als allgemeine Voraussetzung für Änderungen oder Deployments einführen.

Diese Vorgabe gilt für die bezeichnete Foundry-Entwicklungsumgebung. Credentials, Schlüssel, Provider-Sessions, persönliche T3-Daten (`~/.t3/userdata`) sowie fremde Dienste und Repositories sind davon ausgenommen und dürfen nicht beiläufig gelöscht oder offengelegt werden. Anforderungen für eine spätere Produktionsumgebung werden dadurch nicht aufgehoben.

**Keine Sicherungspflicht bedeutet weiterhin überprüfbare Auslieferung:** exakten getesteten Commit/Artefaktdigest verwenden, Deployment-Lock respektieren, vorherige und neue Revision sowie Schema-Verträglichkeit feststellen, Healthcheck und betroffene Funktion prüfen. Ein Wiederherstellungsweg kann in dieser Umgebung aus Neuaufbau/erneutem Deployment und nötigenfalls einem Reset der Entwicklungsdaten bestehen; er braucht keine Sicherung alter Daten oder Builds. Bei Schemaänderungen die Konsequenzen benennen. Bestehende Locks und laufende Deployments nicht umgehen.

Konkrete Anpassung des Updaters: **Paket U02**. Diese Vorgabe ist zentral und gilt auch für alle anderen Pakete.

### Produkt und Architektur

- Kein Foreman und kein verpflichtender überwachender Eltern-Agent. Orchestrierung bleibt servicebasiert. Ein optionaler Integrationsworkflow ist gesondert in N08 beschrieben.
- Vorhanden: sequenzielle Runs, Git-Definitionen, Inbox, Handoff, wiederverwendbare v4-Agenten/Skills, explizite Codex-MCP-Bindings und parallele DAGs/Swarms. Diese Grundlagen weiterverwenden.
- Factory-Definitionen gehören ins Definitionsrepository. Aktivierung und unveränderliche Run-Pins erhalten; „neuestes main“ verändert keine laufenden Runs.
- PostgreSQL für zentrale Automation/Registry; lokales T3-SQLite bleibt separat. Services besitzen Verhalten; HTTP/MCP/UI nutzen dieselben Methoden.
- Zielplattformen: Linux Main/Worker, Web und Windows Desktop. Mobile-Features und native Mobile-Abnahme bleiben zurückgestellt; gemeinsame Verträge kompatibel halten.
- Bei Implementation gelten AGENTS.md und Foundry-Dokumente: eigener Branch, fokussierte Tests, `vp run check:changed`, PR gegen Fork-main, getestete Auslieferung auf Entwicklungs-VPS. Kein Merge ohne ausdrücklichen Auftrag. Menschliche Designabnahme bleibt gesondert offen.
- Visuelle Änderungen mit Vorher/Nachher und einem integrierten realen Clientpass belegen. Logik-/Persistenz-/Autorisierungsänderungen mit fokussierten Tests auf passender Ebene absichern. Keine bezahlten Providerturns für bloße UI-Nachweise.

## Vergabeübersicht

| Paket | Typ                     | Auftrag                                                   | Start / Abhängigkeit                                |
| ----- | ----------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| U01   | UI und Kleinkram        | Bestehende Oberflächen verständlich und konsistent machen | Sofort; ein Agent für das gesamte Paket             |
| U02   | Betriebsänderung        | Updater ohne unnötige Entwicklungs-Backups                | Sofort; laufenden Rollout koordinieren              |
| B01   | Substanzielle Änderung  | Zentraler Einstieg, Sessions und Gerätezugang             | Sofort; UI-Abstimmung mit U01                       |
| B02   | Substanzielle Änderung  | Git als konsistente Definitions-/Triggerquelle            | Sofort; U01 bleibt bei Darstellung                  |
| B03   | Substanzielle Änderung  | Chat-Zuordnung und Handoff-Sichtbarkeit                   | Sofort; B01 für zentralen Zugang                    |
| B04   | Substanzielle Änderung  | Fragen, Entscheidungen und Aktivitätszustände             | Sofort; U01 zeigt nur vorhandene Semantik           |
| N01   | Neue zentrale Fähigkeit | Provider-/Kontoverbindungen für Worker                    | Sofort; Sandbox-Anbindung nach N02                  |
| N02   | Neue Fähigkeit          | Factory-Runner und vollständiger Sandbox-Lebenszyklus     | Bestehende Sandbox-PRs zuerst abgleichen            |
| N03   | Neue Fähigkeit          | Aktivität, Nutzungszuordnung und Kosten-Dashboard         | Datenmodell zuerst; mit N04 abstimmen               |
| N04   | Neue Fähigkeit          | Versionierte Scorers und Evaluationen                     | Eigenständig; nutzt vorhandene Run-Evidence         |
| N05   | Neue Fähigkeit          | Benchmarks und belegte Verbesserungsschleifen             | Nach N04; Kosten aus N03 soweit verfügbar           |
| N06   | Neue externe Fähigkeit  | Machine-Schreibzugang, CI und Foundry-MCP                 | Bestehende Services nutzen; N07/N08 später anbinden |
| N07   | Neue Zusammenarbeit     | GitHub-Dialog, Kommentartrigger und Dispatcher            | Services zuerst; N06 kann sie später exponieren     |
| N08   | Neue Planung            | Dauerhafte Pläne und optionale Ergebnisintegration        | Nach Kindworkflow-Vertrag N07; Agentzugang N06      |

Die Pakete sind fachliche Vergabeeinheiten, keine Aufforderung, alle gleichzeitig zu starten. U01 und U02 können unmittelbar beginnen. Backend-Pakete liefern ihre eigene erforderliche UI mit; U01 wird dadurch nicht zum dauernden Sammelbecken für neue Featureseiten. Gemeinsam bearbeitete Verträge und Migrationen vor paralleler Arbeit abstimmen. Keine bestehenden Sandbox-Arbeiten doppelt implementieren.

## Sofort möglich: UI, Kleinkram und Betrieb

### U01 – Gesamtes UI-/Kleinkram-Paket auf vorhandenen Fähigkeiten

**Ein Agent übernimmt dieses gesamte Paket.** Quellen: F02/F04/F06/F08/F10/F12/F15–F19 sowie Darstellungsanteile F13/F14/F20/F21. Ziel ist eine verständliche vorhandene Anwendung; neue Backend-Fähigkeiten gehören in die anderen Pakete.

**Umfang:**

- Factory-Kontext in eine scrollbare Sidebar mit aufklappbaren Factories und textlichen Unterseiten bringen; Chats und Settings unten erhalten. Vorhandene Factory-Seiten verwenden. Keine leeren Evaluations-/Sandboxseiten vortäuschen. Für Factory-Icons nur vorhandene Metadaten verwenden; eine Schemaerweiterung mit B02 abstimmen.
- Factory-, Work- und Run-Zeilen als natürliche Navigationsziele gestalten; sekundäre Aktionen und Tastaturbedienung erhalten. Index auf Auswahl/Überblick reduzieren. Git-gebundene Factories nicht über eine konkurrierende lokale Erstellung bearbeiten.
- Settings nach global, Factory, Maschine und interaktivem Projekt verständlich ordnen. Bestehende Einstellungen nicht pauschal entfernen. Ressourcen und Connections mit einer eindeutigen sichtbaren Zuständigkeit versehen; zentrale Providerverwaltung entsteht erst mit N01.
- Angemeldeten Nutzern Account-/Profilmenü mit passenden bestehenden Aktionen geben. Browser-Instanzfeld aus dem üblichen Loginfluss nehmen, soweit der bestehende Herkunfts-/Identitätsvertrag das zulässt; Desktop-Instanzwahl erhalten. Änderungen an Auth-Verhalten an B01 geben.
- Work-Details nach Auftrag/Input → Ausführung → Ergebnis/PR/Änderungen gliedern. Vorhandene Diffs, Herkunft, Runs und Kommentare zugänglich machen; Betriebsdetails einklappbar. Fehlende Daten als fehlend zeigen.
- Workflowstart als fokussierte Aktion mit vorhandenen Defaults und erweiterten Einstellungen gestalten. Interne Revisionen aus dem normalen Formular nehmen, intern erhalten. Start-/Autorisierungs-/Default-Aktionen eindeutig benennen.
- Handoff prominent am passenden Run anbieten und Rücklinks/Verlauf darstellen. Die Zuordnung zu Chats gehört B03.
- Rollen, Skills und Workflows zu vorhandenen gerenderten/Git-Definitionen verlinken; benutzerfreundliche Namen nutzen, stabile Identität erhalten. Fehlende Metadaten/Quellverträge an B02 geben.
- Vorhandene Ablauf-/Swarm-/Iterationsdaten visuell verständlich ordnen. Tatsächlichen Worker zeigen; Sandbox nur bei echter Capability. Technische Retries und fachliche Reviewrunden unterscheiden.
- F19 reproduzieren und Rücknavigation global/Factory einschließlich Filter korrekt erhalten; sinnvollen Deep-Link-Fallback vorsehen.
- Vorhandene Fragen und Antwortaktionen verständlich darstellen. Persönliches Done nicht als beantwortet oder freigegeben beschriften. Neue Entscheidungssemantik gehört B04. Vorhandene Aktivität zeigen; neue Kosten-/Qualitätsmetriken gehören N03–N05.

**Abnahme:** zusammenhängender Pfad Factory → Auftrag → Start → Run → Entscheidung → Handoff → Rückkehr; globale/Factory-Rücknavigation, Reload/Deep Links, viele Factories, schmale/breite Ansichten, Hell/Dunkel, Tastatur sowie Lade-/Fehler-/Offline-/Rechtefälle prüfen. Vorher/Nachher-Evidence liefern. Menschliche Designabnahme ausdrücklich offen lassen, bis bestätigt.

**Einstieg:** `apps/web/src/foundry/FoundrySidebar.tsx`, `FactoryNavigation.tsx`, `FoundryPage.tsx`; `apps/web/src/features/automation/{FactoryPage,WorkItemDetail,RunDetail,RunList,AgentCatalog,HandoffPanel,InboxDetail,V4RunProgress}.tsx`.

### U02 – Entwicklungs-Updater von Sicherungsballast befreien

**Quelle:** ergänzender Maintainerauftrag aus dieser Unterhaltung. Aus einem anderen laufenden Thread wurde gemeldet: geprüftes Artefakt für `d8d32dfa4`, Recovery unter `/var/lib/foundry-deploy/upgrade-l8m1qj2_`, lange Sicherung wegen gewachsener Archivdaten; Provisioner wird aus genau demselben Artefakt vorbereitet. Das ist eine übermittelte Momentaufnahme, hier nicht unabhängig geprüft.

**Umfang:**

- Konkreten Updater-/Recoverypfad und die tatsächlich kopierten Daten ermitteln. Unterscheiden zwischen nötiger temporärer Bereitstellung des neuen Artefakts und entbehrlichen Sicherungen alter Daten/Builds.
- Für diese Entwicklungsumgebung Sicherungen/Kopien umfangreicher Archivdaten und alter Builds aus dem notwendigen Updatepfad entfernen beziehungsweise gezielt überspringbar machen. Vorhandene Entwicklungs-Konfiguration nutzen; keine allgemeine Backup-Plattform bauen.
- Bisherige Recovery-Verzeichnisse nur nach Eigentums-/Zweckprüfung und Abstimmung mit einem aktiven Rollout bereinigen. Keinen laufenden Backup-/Updateprozess blind abbrechen; aktiven Lock weder umgehen noch doppelt erwerben.
- Exakte Artefaktbindung für Main, Worker/Provisioner und nötige Migrationen erhalten. Commit `d8d32dfa4` ist historischer Kontext, kein Auftrag zum Zurückdeployen über einen neueren Stand.
- Manifest/Erfolgseintrag, vorherige/neue Revision, Schemahinweise und Gesundheitsprüfung weiterführen. Recovery für Entwicklungsdaten als Neuaufbau/erneutes Deployment mit gegebenenfalls Reset beschreiben.

**Abnahme:** ein Update im Entwicklungsmodus läuft ohne Sicherung der alten Archivdaten/Builds durch; getestete Artefaktidentität und Gesundheitsprüfung sind belegt. Relevante Updater-Tests decken den geänderten Pfad und Fehlerbehandlung ab. Persönliche Daten/Credentials und nicht zugehörige Verzeichnisse bleiben geschützt. Kein unbeabsichtigtes Abschalten späterer Produktionssicherungen.

**Einstieg:** `docs/foundry/operations.md`, installierter `foundry-deploy` und zugehörige Updater-/Provisioner-Quellen über Repositorysuche ermitteln. Aktuelle Deploymentrevision und laufenden Vorgang zuerst prüfen.

## Substanzielle Änderungen bestehender Funktionen

### B01 – Ein zentraler Einstieg mit stabilen Sessions und Gerätezugang

**Quellen:** F01–F03/F07; Planbezug P03N/P05/P12. U01 besitzt die Darstellung, dieses Paket Auth-/Verbindungsverhalten.

**Umfang:** frische/abgelaufene Sessions vor geschützten Oberflächen zum Login führen und Ziel nach Anmeldung wiederherstellen. Nach zentraler Anmeldung autorisierte Geräte und Chats ohne manuelles „Open device“ oder wiederholtes Pairing erschließen. Gemeinsames Inventar mit Online-/Offline-Zustand und Maschinenrollen verwenden. Tatsächliche Ursache der frühen Abmeldung pro Schicht untersuchen: Foundry, T3, Access, Refresh oder Clientzustand. Native Anmeldung mit bestehendem Plan abgleichen; nicht stillschweigend als bereits vorhanden voraussetzen.

**Abnahme:** Neu-/Wiederanmeldung, Deep Link, Reload, Refresh/Ablauf, Logout/Widerruf und Offlinegerät funktionieren; geschützte Daten bleiben autorisiert. Web und Windows-Einstieg unterscheiden sich sinnvoll. Keine pauschale Verlängerung von Tokens ohne Fehlerursache.

**Einstieg:** `apps/web/src/foundry/{instanceSession,onboarding,devices}.ts`, `FoundryPage.tsx`, `DeviceCatalog.tsx`, Foundry-Auth-/Gateway-Services. Session-/Berechtigungs- und Verbindungstests erweitern.

### B02 – Definitionsrepository, Revisionen und Trigger aus einer Quelle

**Quellen:** F10–F13, Schemaanteil F08; Planbezug P47/P48/P52. U01 besitzt Links und Layout.

**Umfang:** zentrale Quellkonfiguration mit standardmäßig neuestem `main` sowie bewusster Branch-/Commitwahl; effektive Revision und Aktivierung trennen. Git-gebundene Trigger nur anzeigen und aus Git synchronisieren, konkurrierende Mutationspfade beseitigen. Herkunft, Anzeigenamen und nötigenfalls Factory-Iconmetadaten für UI verlässlich bereitstellen. Lokal verwaltete Altdefinitionen ausdrücklich behandeln, ohne ihre Migration beiläufig zu erzwingen.

**Abnahme:** Quellwechsel/Sync/Validierung/Aktivierung nachvollziehbar; laufende Runs behalten ihren Pin. Git-Trigger lassen sich weder per UI noch über einen konkurrierenden API-Weg abweichend konfigurieren. Ungültige Revisionen/Definitionen liefern verständliche Fehler.

**Einstieg:** `DefinitionSources.ts`, `DefinitionSync.ts`, `Definitions.ts`, `Triggers.ts`, Definitionverträge und Loader in `packages/shared`; Abstimmung mit N02 über Runner-Definitionen.

### B03 – Interaktive Chats und Automation sauber zuordnen

**Quellen:** F09/F17, Zugangsteil F03. Vorhandenen Handoff weiterverwenden.

**Umfang:** automatisch erzeugte Ausführungsthreads aus der normalen Chats-Liste heraushalten, im Factory-/Run-Kontext erreichbar halten. User-Chats und ausdrücklich übernommene Runs in Chats anzeigen. Übernahme, Rückgabe, Herkunft und historische Verknüpfung dauerhaft unterscheiden; keine Daten löschen, um Listen zu bereinigen.

**Abnahme:** automatisierter Run erzeugt keinen gewöhnlichen Chat-Eintrag; Übernahme zeigt den richtigen Thread und Codezustand. Rückgabe/erneute Übernahme/Reload bewahren Herkunft und Autorisierung. Historische Datensätze haben nachvollziehbares Verhalten.

**Einstieg:** `Handoffs.ts`, `apps/web/src/foundry/FactoryThreadAccess.tsx`, Chatprojektionen/-filter und `packages/client-runtime`; Klassifikation und Persistenz auf niedrigster geeigneter Ebene testen.

### B04 – Entscheidungen als echte Fragen mit eindeutigen Zuständen

**Quellen:** F20/F21. U01 verbessert vorhandene Darstellung; dieses Paket ergänzt fehlendes Verhalten.

**Umfang:** echte Frage, Optionen/Freitext, Kontext und exakt wartenden Step/Attempt transportieren. Beantwortung und fachliche Erledigung verbinden; persönliche Inboxorganisation, ungelesen, beantwortet, überholt und abgebrochen unterscheiden. Explizites Schließen versus Workflowabbruch fachlich festlegen. Globale Aktivitätsansicht für relevante Runs/Entscheidungen anbieten; gemeinsames Ereignismodell mit N03 abstimmen.

**Abnahme:** Antwort trifft ausschließlich die aktuelle Frage/Revision; veraltete Antwort kann keinen neuen Attempt steuern. Done erteilt keine Freigabe. Schließen/Cancel hat sichtbare, dokumentierte Wirkung; Refresh/Mehrgerätebedienung verliert keinen Zustand.

**Einstieg:** `Inbox.ts`, `Control.ts`, Inboxverträge, `InboxPage.tsx`, `InboxDetail.tsx`, bestehende T3-Frageinteraktion. Neue Zustandsübergänge und Autorisierung fokussiert testen.

## Neue Funktionen und größere Erweiterungen

### N01 – Zentrale Provider- und Kontoverbindungen

**Quellen:** F05/F04, verbleibende Ressourcenlücke; P14Z/P52.

**Umfang:** Providerzugänge zentral einrichten, prüfen, erneuern und widerrufen; konkrete autorisierte Nutzung auf Workern ermöglichen. Linux/Codex zuerst, weitere Provider einzeln anhand ihrer tatsächlichen Credential-/OAuth-Möglichkeiten. Source-Control-/MCP-Verbindungen mit vorhandenen GitHub-/MCP-Bindings abgleichen; keinen zweiten Secretstore erfinden. Main-Status und Worker-Ausführungsbereitschaft unterscheiden. Sandbox-Nutzung über N02 anbinden. Automatisches Modellrouting ist eine gesonderte spätere Erweiterung und kein notwendiger Teil dieser ersten Lieferung.

**Abnahme:** zentrale Anmeldung ergibt nutzbaren Zugang auf einem autorisierten Worker ohne zusätzliche CLI-Anmeldung; Refresh und Widerruf wirken nachweisbar. Fehlender/ungeeigneter Providerzugang wird korrekt angezeigt. Keine Credentials in Logs, Definitionen oder Artefakten.

**Einstieg:** Foundry-Provider-/Worker-Services, `WorkerResources.ts`, `WorkerReadiness.ts`, vorhandene Managed-Codex- und MCP-Bindings; konkrete Credential-Grenze vor Implementierung festlegen.

### N02 – Factory-eigene Runner und reproduzierbare Sandboxes

**Quellen:** F29/F18/F05; P34–P40. Dokumentierte parallele Arbeiten vor Beginn abgleichen und übernehmen statt duplizieren.

**Umfang:** Runner im Verzeichnis jeder Factory versionieren und an Agent-/Workflowausführung binden; Plattform, Ressourcen, Image und Setup ausdrücken. Profile validieren und tatsächlich auf Host/Provisioner auflösen. Linux-OCI-Sandbox anfordern, bereitstellen, registrieren und vorbereiten; passende Providerautorisierung aus N01 verwenden. Laufzeit/Verlängerung/Abbruch/TTL sowie Archivierung, Löschung und Fortsetzung integrieren. Client zeigt Provisionierung und tatsächliche Maschine/Sandbox am Run.

**Abnahme:** gepinnte Runnerdefinition führt zu einer frisch bereitgestellten, tatsächlich genutzten Umgebung. Fehler bei Setup, Kapazitätsmangel, Cancel und Neustart sind beherrscht. Thread, Anhänge und Git-Ergebnis bleiben nach Löschung verfügbar; Fortsetzung auf neuem Environment funktioniert. Entwicklungsdaten brauchen keine zusätzlichen Sicherungen.

**Einstieg:** Sandbox-PRs, Worker-/Registry-/Archive-Services, Scheduler und Definitionsverträge. Runner-Schema und Overrides mit B02 abstimmen. Bestehender Host-Worker bleibt nutzbar.

### N03 – Nutzungsdaten, Kosten und operatives Factory-Dashboard

**Quellen:** F14/F32, Aktivitätsanteile F18/F21; P54.

**Umfang:** Runs, Work Items, PRs und Ereignisse belastbar zuordnen. Zeiträume, Cycle Time und tatsächliche Aktivität darstellen. Kosten für Inference/Compute/Plattform mit Herkunft, Schätzung und fehlenden Daten modellieren; Retries, erfolglose Arbeit und Arbeit ohne PR berücksichtigen. Kennzahl „Kosten pro PR“ und Vergleichszeitraum definieren. Aktivitätszustände mit Run/Worker/Agent und Aktualität verlinken. Zustandsdarstellung mit B04 teilen.

**Abnahme:** Summen und Kategorien sind nachvollziehbar; Drill-down führt zur Evidence. Unbekannt ist nicht null. Rework/Autonomie/Qualität nur mit begründeter Definition anzeigen; keine ausgedachten Erfolgszahlen. Dashboard kann zunächst vorhandene Aktivität liefern, bevor alle Kostenquellen existieren.

**Einstieg:** Automation-Persistenz, Publish-/Run-/Archivdaten und `FactoryPage.tsx`; erforderliche Ereignisse/Projektionen und Abgrenzung zur Scoring-Historie N04 zuerst festlegen.

### N04 – Versionierte Scorers und Evaluationen über historische Arbeit

**Quellen:** F22/F31/F33; P55.

**Umfang:** Git-versionierte Kriterien, Judge-Konfiguration, Klassen/Schwellen und Sampling; manuelle und automatische Bewertung abgeschlossener Runs. Historie mit bewerteter Definition, Modellkonfiguration, Scorerrevision und konkreter Evidence. Factoryübergreifende Evaluationsagenten/-workflows ermöglichen; Definitionen nicht zwingend in eine einzelne Factory pressen. Ergebnisansichten und verständliche Fehler-/Unvollständigkeitszustände liefern.

**Abnahme:** Bewertung reproduzierbar zugeordnet, Quelle inspizierbar; Neubewertung überschreibt keine historische Aussage. Fehlende Evidence und Judgefehler werden sichtbar. Keine stillschweigende Aktivierung geänderter Definitionen. Metriken müssen erklärt sein.

**Einstieg:** vorhandene Run-/Threadarchive, Definitionsmodell und Automation-Services. Service/Verträge/Migrationen vor Dashboardintegration mit N03/N05 abstimmen.

### N05 – Vergleichbare Benchmarks und belegte Verbesserung

**Quellen:** F22/F30/F31; P56/P57. Benötigt N04; Kostenintegration nutzt N03.

**Umfang:** Suites aus realen oder manuell gewählten Aufgaben, feste Repository-Ausgangsstände, Varianten für Modell/Reasoning/Definition und steuerbare Trials. Qualität, Zeit und verfügbare Kosten mit vergleichbaren Bedingungen visualisieren. Aus wiederkehrenden Fehlern belegte Vorschläge/PRs gegen Definitionen ableiten; Änderung erneut gegen Baseline bewerten. Prompt-/Skill-/Memoryänderungen nur mit expliziter Herkunft und Aktivierung. Kein beliebiger „Winner“ allein nach Preis.

**Abnahme:** Konfigurationen auf gemeinsamer Taskbasis vergleichbar; abweichende Bedingungen/fehlende Messungen sichtbar. Verbesserung, Regression und erfolgloser Versuch bleiben mit Vorher/Nachher-Belegen erhalten. Ein Vorschlag verändert keine aktiven Definitionen ohne den vorgesehenen Freigabeweg.

**Einstieg:** N04-Verträge/Resultate, Workflowausführung, Definitionsrepository-/PR-Publishing; vorgeschlagene Chartreferenzen im Originalfeedback.

### N06 – Externer Maschinenzugang, CI und Foundry-MCP

**Quellen:** F34/F33, Agentzugang F27; P58. Bestehende HTTP-API und Maschinen-Lesecredentials weiterverwenden.

**Umfang:** Factory-begrenzte Maschinenstarts/-steuerung mit Ablauf/Widerruf und idempotenten Requests ergänzen. Öffentlichen Access-/CI-Pfad tatsächlich abnehmen. Foundry-MCP für Kontextsuche, unterstützte Workflows/Definitionen, Auftrag/Runstart einschließlich konfigurierter Swarms sowie Status/Ergebnisse liefern; unterstützte Steuerung und Handoff explizit festlegen. MCP ruft vorhandene Services auf. Externe MCP-Server als Agentenressourcen sind eine andere, bereits teilweise vorhandene Fähigkeit.

**Abnahme:** externer autorisierter Agent entdeckt eine Factory, startet genau einen gepinnten Run/Swarm und liest Ergebnis; Wiederholung erzeugt keinen Duplikatstart. Scopeverletzung/Widerruf schlägt korrekt fehl. CI benötigt keine interaktiven Cookies. T3-MCP-Tokens werden nicht als Foundry-Identität behandelt. Model-facing Texte gemäß Evals-Vorgaben prüfen.

**Einstieg:** `ApiHttp.ts`, `MachineAccess.ts`, `Application.ts`, `Control.ts`, Maschinencredentials und API-Verträge. Planoperationen erst nach N08 ergänzen; Basis-MCP nicht davon blockieren.

### N07 – GitHub-Rückmeldungen, Kommentartrigger und Kindworkflows

**Quellen:** F23–F26, Routinganteil F33. Vorhandenes Polling und PR-Publishing erweitern.

**Umfang:** sinnvolle Lifecycle-/Ergebnisrückmeldungen am Ursprungsissue/PR; Inhalt im konfigurierten Rahmen flexibel, ohne Kommentarspam. Berechtigte Erwähnungen/Kommandos als Trigger mit festgelegter Syntax unterstützen. Dispatcherworkflow kann klassifizieren und passenden Kindworkflow starten. Herkunft, Eltern-/Kindrelation, Limits und Fehlersichtbarkeit erhalten. Agents dürfen über einen autorisierten Service neue verknüpfte GitHub-Issues erstellen.

**Abnahme:** Kommentar startet korrekte Arbeit mit Quellkontext; Pollingwiederholung/Retry erzeugt keine Duplikate. Eigene Kommentare/erzeugte Issues lösen keine unbeschränkte Rekursion aus. Teilfehler und abgelehnte Aufrufer sichtbar. Kindstarts bleiben service-orchestriert und begrenzt.

**Einstieg:** `GitHubApp.ts`, `GitHubPolling.ts`, `Triggers.ts`, `Publish.ts`, `Workflows.ts`; Kindstartvertrag mit N08 und transportfähige Services mit N06 abstimmen. Reines GitHub-Verhalten kann vor MCP liefern.

### N08 – Dauerhafte Featurepläne und optionale Ergebnisintegration

**Quellen:** F27/F28/F33/F34. Benötigt Kindworkflow-Semantik N07; Chat-/Agentzugang über N06.

**Umfang:** aus Factory-bezogenem Chat einen in Foundry sichtbaren, dauerhaften Plan mit Items, Abhängigkeiten, Workflowzuordnung, Issues und Runs erstellen. Bewusst einzelne/mehrere Items starten und Zustände über Fehler/Retry erhalten. Optionaler abschließender Workflow prüft Ergebnisse gegen den Plan, übernimmt Integration auf einer bekannten Revision und startet Abschlusstests. Repositoryübergreifende Zuständigkeiten und Konfliktbehandlung ausdrücklich gestalten.

**Abnahme:** Plan überlebt Chatende/Reload; Abhängigkeiten verhindern verfrühte Starts; Retry dupliziert keine Items/Runs. Teilfehler, Blockaden und Änderungen bleiben nachvollziehbar. Integration hat bekannte Inputs, verantwortliche Rolle und getestete Endrevision. Kein verpflichtender Foreman; Merge/Deployment nur nach den ausdrücklich geltenden Autorisierungsregeln.

**Offen vor Umsetzung:** Planmodell und Änderbarkeit, Integrationseigentümer, Umgang mit Konflikten sowie menschliche Abschlussgates. Diese Punkte als konkrete Produktentscheidungen lösen, keine pauschale automatische Mergepolitik unterstellen.

**Einstieg:** WorkItem-/Workflow-/Runverträge, Chat-Factory-Kontext, N06-MCP und N07-Kindstarts. Planpersistenz ist ein Produktfeature und gehört nicht als Laufzeitdaten in diesen lokalen Planordner.

## Vollständigkeit und gemeinsame Übergabe

| Feedback                        | Hauptverantwortung                                               |
| ------------------------------- | ---------------------------------------------------------------- |
| F01/F03/F07                     | B01                                                              |
| F02/F04/F06/F08/F10/F12         | U01; B01 Auth, B02 Metadaten/Ownership, N01 neue Kontoverwaltung |
| F09/F17                         | B03; U01 Darstellung                                             |
| F11/F13                         | B02; U01 Darstellung                                             |
| F14/F32                         | N03                                                              |
| F15/F16/F18/F19                 | U01; N02 für echte Sandboxinformationen                          |
| F20/F21                         | B04; U01 Darstellung, N03 operative Metriken                     |
| F22                             | N04/N05                                                          |
| F23/F24/F25/F26                 | N07                                                              |
| F27/F28                         | N08; Agentzugang N06                                             |
| F29                             | N02                                                              |
| F30/F31                         | N05; Bewertungsbasis N04                                         |
| F33                             | Zentrale Produktgrenzen, Umsetzung in den genannten Paketen      |
| F34                             | N06                                                              |
| Neuer Hinweis zu Backup/Updater | Zentrale Entwicklungsregel und U02                               |

Jeder umsetzende Agent berichtet konkrete Änderungen, getesteten Commit, Prüfungen, offene Produkt-/Abnahmepunkte und PR. Bei Auslieferung zusätzlich vorherige/neue Revision oder Digest, Healthcheck und Wiederherstellungsweg ohne vorausgesetzte Datensicherung nennen. Bei gemeinsam genutzten Dateien nennt er notwendige Folgeänderungen für die anderen Pakete. Dieser lokale Vergabeplan ist kein zweites dauerhaftes Implementierungsprotokoll; Umsetzung und aktive Arbeit gehören später in Issue/PR.
