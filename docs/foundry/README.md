# Foundry-Entwicklung

Einstieg für die Weiterentwicklung unseres dauerhaften T3-Code-Forks. Foundry ist als selbst gehostete Single-User-Software-Factory auf T3 Code ausgerichtet. Factories sind Home und Hauptanwendung; Chats bleiben als Arbeitsdetails eines Auftrags und als sekundärer interaktiver Einstieg erreichbar: mit einer Hauptdomain, registrierten Devices, produktbezogenen Factories, Factory as Code und Linux-Sandboxes. Warp Factories dient als Referenz für Funktionsumfang und Seitenaufteilung; Gestaltung und interaktive Agentenarbeit kommen aus T3 Code. Die Main Node steuert; ein eigener Host-Worker führt zunächst Agenten aus.

## Wo anfangen?

| Dokument                                  | Zweck                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| [Architektur](architecture.md)            | Produktumfang, Zuständigkeiten, Workflow-Semantik, Isolation und vorhersehbare Risiken |
| [Deployment-Design](deployment.md)        | Instanzanmeldung, Gateway-Vertrauen, Cloudflare, Persistenz und Hosting-Grenzen        |
| [Umsetzungsplan](implementation-plan.md)  | Features, Funktionen, Reihenfolge und funktionale Abnahmen                             |
| [Warp-Vergleich](warp-comparison.md)      | Code-/Browserbefund zu Funktionen und UI sowie begründete Prioritäten                  |
| [Basic-Leitplanken](basic-leitplanken.md) | Sicherheit, Optimierung, Backups, Betrieb und technische Prüfgates                     |
| [Betrieb](operations.md)                  | Tatsächlich vorhandenen Grundbetrieb bauen, starten, koppeln und wiederherstellen      |
| [Fork-Wartung](maintenance.md)            | Branch/Commit/PR, Upstream-Integration und sparsamer Actions-Betrieb                   |

Architektur und Deployment erklären **was und warum**; der Umsetzungsplan besitzt **Feature-Reihenfolge und funktionale Abnahme**. Basic-Leitplanken führt technische Voraussetzungen, Sicherheits- und Betriebsabnahmen separat. Nur der Betriebsleitfaden beschreibt vorhandene Bedienwege. Ein Arbeitspaket im Plan ist keine Implementierungszusage für den aktuellen Build.

## Zielvision und Erweiterung

[Architekturabschnitt 3.2](architecture.md#32-zielvision-eine-software-factory-innerhalb-von-t3-code) enthält die Feature-Liste mit Warp-Quellen und Abgleich zum bisherigen Plan. Abschnitt 3.3 legt Factory as Code fest; Abschnitt 12 beschreibt die globale und Factory-bezogene Navigation im T3-Design. Der Umsetzungsplan integriert dies über P18a/P18b und P47–P60 mit eigenen Abnahmegates.

## Vorhandener Stand und nächster Schritt

Main, Instanz-PostgreSQL, Access und native Operator-Anmeldung, Gateway sowie dauerhafter Linux-Worker sind integriert. Der Factory-Kern umfasst Runs, Inbox/Steuerung, GitHub-Polling und PR-Publishing, Zeitpläne, Git-Definitionen und T3-Handoff. Versionierte v4-Rollen und Skill-Bundles, explizite MCP-Bindings, parallele Swarms und Review/Fix-Runden sind für Linux/Codex und Web geliefert. Die Integrationslieferung [PR #91](https://github.com/niklaskastning/foundry/pull/91) ergänzt zentrale Codex-Verbindungen, Definitionsquellen, Operationsdaten, versionierte Scorers und Evaluationen sowie schlanke Remote-basierte Resume-Archive mit erhaltenem Threadverlauf und Git-Index.

Die Sandboxlieferung P34–P40 und ihre Betriebsbereinigung sind integriert. Echte OCI-Container dienen interaktiver Arbeit und manuellen v4-Starts; bestätigtes Archivieren, Löschen und Fortsetzen auf einer frischen Umgebung ist real nachgewiesen. Die Benutzeranmeldung leitet die Main-T3-Sitzung ab; ein getrenntes Main-Pairing ist nicht mehr Voraussetzung. Weitere Provider-/Kontotypen und die vollständige native Windows-Bedienung behalten eigene offene Gates.

Der Factory-Arbeitsplatz wurde zuletzt in [PR #92](https://github.com/niklaskastning/foundry/pull/92) überarbeitet und mit automatisierten Prüfungen, integriertem Browserpass und unabhängigem Review geprüft. Das ersetzt nicht die menschliche Designabnahme aus [Issue #73](https://github.com/niklaskastning/foundry/issues/73).

P58/N06 liefert die versionierte HTTP-API, Factory-begrenzte Lese-/Start-/Control-Credentials und Foundry-MCP über dieselben Services. [PR #93](https://github.com/niklaskastning/foundry/pull/93) behebt die gemeinsame Gateway-Autorität und bestätigt den direkten Maschinen-MCP-Pfad bis zum erfolgreichen Freigabe-Workflow. Öffentlicher Access-/CI-Zugang und Modell-Evals bleiben offen; N06 ist deshalb insgesamt noch nicht abgenommen.

Als nächste neue Produktfähigkeit folgt N05/P56: wiederholbare Benchmarks auf gleicher Task- und Repositorybasis, anschließend belegte Verbesserungsvorschläge P57. N07 ergänzt GitHub-Dialog/Kommentartrigger und begrenzte Kindworkflows; darauf kann N08 mit dauerhaften Featureplänen aufbauen. Der [Umsetzungsplan](implementation-plan.md#nächste-produktlieferungen) besitzt Reihenfolge und funktionale Abnahme, [Basic-Leitplanken](basic-leitplanken.md) die technischen Gates. Die Definitionen liegen im separaten privaten Repository [foundry-definitions](https://github.com/niklaskastning/foundry-definitions).

## Arbeitsweise

Jedes Arbeitspaket erhält einen eigenen Branch, fokussierte Commits und einen PR zum Fork. Die IDs P01–P60 sind Planungsschlüssel, keine GitHub-PR-Nummern. Erledigte Features und offene funktionale Abnahmen stehen auf Maintainerwunsch im Umsetzungsplan, technische Nachweise in Basic-Leitplanken; konkrete Entscheidungen und Nachweise bleiben im zugehörigen Issue/PR. Ein Gate wird mit den tatsächlich geprüften Commit-/Build-Ständen belegt.

Die Maintainer-Vorgaben stehen in [AGENTS.md](../../AGENTS.md). Ein automatischer PR-Check, manuelle Artefakt-Builds bei Bedarf; keine zusätzliche CI-Matrix. Implementierungsnotizen und temporäre Versuchsergebnisse bleiben außerhalb des Repositories. Die ausdrücklich angeforderten Architektur-, Deployment-, Umsetzungs- und Leitplankendokumente sind versionierte Ausnahmen davon.

Das abgeschlossene [Issue #13](https://github.com/niklaskastning/foundry/issues/13) archiviert die bisherigen Integrations- und Windows-Nachweise. Offene Punkte sind nach Produktfunktionen im Umsetzungsplan und technischen Arbeiten in Basic-Leitplanken getrennt. Die dauerhafte Freigabe für Deployments einschließlich offener PRs auf diesen Entwicklungs-VPS steht in [AGENTS.md](../../AGENTS.md#development-vps-and-agent-autonomy). Ein Deployment ersetzt keine Gate-Abnahme; ein Merge benötigt weiterhin einen ausdrücklichen Auftrag.

## Manuell mit Factories arbeiten

Bei aktivierter Automation öffnet Home die **Factories**. **Work** führt zur Factory-Auswahl für Aufträge, **Decisions** zur persönlichen Inbox; Runs und Ressourcen sind nachgeordnet erreichbar. Innerhalb der Factory stehen Übersicht, Arbeit, Agenten, Runs, Definition und Trigger im selben Kontext. **Workflows** zeigt den Ablauf in einem eigenen Tab. **Chats** öffnet die interaktive T3-Arbeit; direkte Threadlinks, Tastaturbefehle und der Rückweg zum Auftrag bleiben erhalten. Ohne Foundry-Fähigkeit bleibt der normale T3-Einstieg bestehen.
Die Foundry-Anmeldung stellt die gebundene Main-T3-Sitzung automatisch her.

Eine Factory legt Repository-Bindungsschlüssel fest. Im Factory-Bereich **Definition** lässt sich eine noch lokal verwaltete
Definition bearbeiten oder als kanonischer Dateisatz importieren und exportieren.
Git-gebundene Factories werden im Definitionsrepository geändert. **Agents & skills**
zeigt den aktiven Rollen-/Skillstand. Die Workflowansicht fasst Ablauf, zusätzliche Ressourcen und wirksame Einstellungen zusammen; Instruktionen und Herkunft bleiben aufklappbar. **Validate** prüft sie; Aktivieren veröffentlicht eine unveränderliche
Definitionsversion für neue Starts. Es veröffentlicht keinen GitHub-PR. Bereits
laufende Runs behalten ihre gepinnte Version.

Für einen manuellen Start einen Auftrag und den passenden Workflow wählen.
Worker-Projekt und weitere Betriebsbindungen können pro Factory/Repository als
Startvorgaben gespeichert und bei späteren Aufträgen wiederverwendet werden. Projekt- und Providerbindung
werden vor dem Start geprüft. Der Run bleibt nach Schließen des Browsers bestehen;
Versuche und Ergebnisse lassen sich später in **Runs** öffnen. Größere Ausgaben werden
erst auf Anforderung geladen. Bestätigte Thread-Archive und Anhänge bleiben über Main
lesbar, auch wenn der Worker offline ist; fehlende Daten bleiben als unvollständig markiert.

Pause verhindert neue Steps und lässt bereits zugestellte Arbeit auslaufen. Cancel
fordert einen Stop an und ist erst nach bestätigtem Writer-Ende abgeschlossen. Ein
bewusstes Retry legt einen neuen Versuch an und setzt einen sicher beendeten alten
Writer voraus. Nach abgelaufener oder entzogener Anmeldung verlangt Resume aktuelle
Autorisierung.

Die persönliche Inbox zeigt vorhandene Fragen, Freigaben, Blocker und Fehler.
**Hide from my inbox** und **Return to my inbox** organisieren nur die persönliche
Inbox; sie genehmigen keine Arbeit und beantworten keine Frage. Beantwortete Fragen
werden automatisch erledigt; beantwortet, überholt und abgebrochen bleiben getrennt
sichtbar. **Close details** schließt nur die Ansicht. **Cancel workflow** fordert
hingegen den Abbruch des gesamten Runs an und wartet auf das bestätigte Writer-Ende. Eine
Freigabe gilt für den angezeigten Eingabe- und Ergebnisstand. Bei geändertem Ergebnis
neu laden und erneut entscheiden. Antworten werden ausdrücklich an die aktuell
zuständige Frage gesendet; eine alte Frage kann keinen neuen Versuch steuern.

## Mit Linux-Sandboxes arbeiten

Unter **Resources** ein freigegebenes Profil wählen und eine Umgebung anfordern.
Setupstatus und Logs zeigen, wann Checkout, Tools und Skills bereit sind. Danach
das Environment für einen interaktiven Thread öffnen. Lebensdauer lässt sich
innerhalb des Profillimits verlängern; Stop beendet die Arbeit, Archivieren und
Löschen wartet auf das bestätigte zentrale Archiv. Im Archiv kann die Arbeit mit
erhaltener Threadherkunft auf einer neuen Umgebung fortgesetzt werden.

Beim manuellen v4-Start optional dieselbe Profilrevision als Sandboxziel wählen.
Der Run zeigt Setup, Kapazitätswartezeit, Fehler und Abbruch; abgeschlossene
Ressourcen werden freigegeben. Vorhandene dauerhafte Worker und ältere Workflows
bleiben nutzbar. Codex verwendet eine zentral autorisierte Verbindung; andere
Provider werden für diesen Sandboxpfad noch nicht angeboten.
