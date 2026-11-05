# Foundry-Entwicklung

Einstieg für die Weiterentwicklung unseres dauerhaften T3-Code-Forks. Foundry soll eine selbst gehostete Single-User-Software-Factory innerhalb von T3 Code werden: mit einer Hauptdomain, registrierten Devices, produktbezogenen Factories, Factory as Code und später Sandboxes. Warp Factories dient als Referenz für Funktionsumfang und Seitenaufteilung; Gestaltung und interaktive Agentenarbeit kommen aus T3 Code. Die Main Node steuert; ein eigener Host-Worker führt zunächst Agenten aus.

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

Main, Instanz-PostgreSQL/Access, Gateway und dauerhafter Linux-Worker sind integriert. Der Factory-Kern umfasst sequenzielle Runs, Steuerung/Inbox, GitHub-Polling und PR-Publishing, Zeitpläne, zentrale Archive, Git-Definitionen und T3-Handoff. P58a stellt eine versionierte HTTP-API für vorhandene Benutzersitzungen sowie Factory-begrenzte Maschinen-Leseabfragen mit eigenen Credentials bereit. Maschinen-Start/-Steuerung und Factory-MCP bleiben offen; der öffentliche Maschinenzugang durch Access benötigt eine eigene Betriebsabnahme. Windows-Anmeldung ist praktisch bestätigt, die vollständige Factory-Bedienung unter Windows noch nicht.

Der [Warp-Vergleich](warp-comparison.md) trennt vorhandene Funktionen von fehlender zentraler Integration und UI-Arbeit. **Nächster großer Schnitt: wiederverwendbare Factory-Agenten mit einem zusammenhängenden Arbeitsplatz (P28/P52a/P49b).** Danach folgen koordinierte Parallelität mit realer Kapazität, Sandboxes und messbare Qualität. Der [Umsetzungsplan](implementation-plan.md#nächste-produktlieferungen) besitzt Reihenfolge und funktionale Abnahme; technische Nachweise stehen in [Basic-Leitplanken](basic-leitplanken.md). Native Anmeldung, zentrale Kontoverbindungen und der Einstieg ohne getrenntes Main-T3-Pairing bleiben eigenständige Produktlücken. Die Definitionen liegen im separaten privaten Repository [foundry-definitions](https://github.com/niklaskastning/foundry-definitions).

## Arbeitsweise

Jedes Arbeitspaket erhält einen eigenen Branch, fokussierte Commits und einen PR zum Fork. Die IDs P01–P60 sind Planungsschlüssel, keine GitHub-PR-Nummern. Erledigte Features und offene funktionale Abnahmen stehen auf Maintainerwunsch im Umsetzungsplan, technische Nachweise in Basic-Leitplanken; konkrete Entscheidungen und Nachweise bleiben im zugehörigen Issue/PR. Ein Gate wird mit den tatsächlich geprüften Commit-/Build-Ständen belegt.

Die Maintainer-Vorgaben stehen in [AGENTS.md](../../AGENTS.md). Ein automatischer PR-Check, manuelle Artefakt-Builds bei Bedarf; keine zusätzliche CI-Matrix. Implementierungsnotizen und temporäre Versuchsergebnisse bleiben außerhalb des Repositories. Die ausdrücklich angeforderten Architektur-, Deployment-, Umsetzungs- und Leitplankendokumente sind versionierte Ausnahmen davon.

Das abgeschlossene [Issue #13](https://github.com/niklaskastning/foundry/issues/13) archiviert die bisherigen Integrations- und Windows-Nachweise. Offene Punkte sind nach Produktfunktionen im Umsetzungsplan und technischen Arbeiten in Basic-Leitplanken getrennt. Die dauerhafte Freigabe für Deployments einschließlich offener PRs auf diesen Entwicklungs-VPS steht in [AGENTS.md](../../AGENTS.md#development-vps-and-agent-autonomy). Ein Deployment ersetzt keine Gate-Abnahme; ein Merge benötigt weiterhin einen ausdrücklichen Auftrag.

## Manuell mit Factories arbeiten

Bei aktivierter Automation öffnen **Factories**, **Runs** und **Inbox** in der
Navigation, der Befehlspalette oder den Verbindungseinstellungen dieselben Ansichten.
Foundry-Anmeldung und die T3-Verbindung zu Main sind beide erforderlich.

Eine Factory legt Repository-Bindungsschlüssel fest. Im Factory-Bereich **Definition** lässt sich eine noch lokal verwaltete
Definition bearbeiten oder als kanonischer Dateisatz importieren und exportieren.
Git-gebundene Factories werden im Definitionsrepository geändert. **Agents & skills**
zeigt den aktiven Rollen-/Skillstand und die Einstellungen der Workflow-Schritte. **Validate** prüft sie; Aktivieren veröffentlicht eine unveränderliche
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
**Done** und **Undo** organisieren die Inbox; sie genehmigen keine Arbeit. Eine
Freigabe gilt für den angezeigten Eingabe- und Ergebnisstand. Bei geändertem Ergebnis
neu laden und erneut entscheiden. Antworten werden ausdrücklich an die aktuell
zuständige Frage gesendet; eine alte Frage kann keinen neuen Versuch steuern.
