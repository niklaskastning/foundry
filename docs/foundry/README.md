# Foundry-Entwicklung

Einstieg für die Weiterentwicklung unseres dauerhaften T3-Code-Forks. Foundry soll eine selbst gehostete Single-User-Software-Factory innerhalb von T3 Code werden: mit einer Hauptdomain, registrierten Devices, produktbezogenen Factories, Factory as Code und später Sandboxes. Warp Factories dient als Referenz für Funktionsumfang und Seitenaufteilung; Gestaltung und interaktive Agentenarbeit kommen aus T3 Code. Die Main Node steuert; ein eigener Host-Worker führt zunächst Agenten aus.

## Wo anfangen?

| Dokument                                 | Zweck                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| [Architektur](architecture.md)           | Produktumfang, Zuständigkeiten, Workflow-Semantik, Isolation und vorhersehbare Risiken |
| [Deployment-Design](deployment.md)       | Instanzanmeldung, Gateway-Vertrauen, Cloudflare, Persistenz und Hosting-Grenzen        |
| [Umsetzungsplan](implementation-plan.md) | PR-große Arbeitspakete, Abhängigkeiten, Prüfgates und Handoffs                         |
| [Betrieb](operations.md)                 | Tatsächlich vorhandenen Grundbetrieb bauen, starten, koppeln und wiederherstellen      |
| [Fork-Wartung](maintenance.md)           | Branch/Commit/PR, Upstream-Integration und sparsamer Actions-Betrieb                   |

Architektur und Deployment erklären **was und warum**; der Umsetzungsplan besitzt **Reihenfolge und Abnahme**. Nur der Betriebsleitfaden beschreibt vorhandene Bedienwege. Ein Arbeitspaket im Plan ist keine Implementierungszusage für den aktuellen Build.

## Zielvision und Erweiterung

[Architekturabschnitt 3.2](architecture.md#32-zielvision-eine-software-factory-innerhalb-von-t3-code) enthält die Feature-Liste mit Warp-Quellen und Abgleich zum bisherigen Plan. Abschnitt 3.3 legt Factory as Code fest; Abschnitt 12 beschreibt die globale und Factory-bezogene Navigation im T3-Design. Der Umsetzungsplan integriert dies über P18a/P18b und P47–P60 mit eigenen Abnahmegates.

## Vorhandener Stand und nächster Schritt

Main, Instanz-PostgreSQL/Access, registrierter Linux-Worker und Gateway sind integriert. Windows/Electron und Firefox greifen auf denselben Worker zu. Windows-Login, Refresh, App-Neustart und Wiederanmeldung mit erhaltener T3-Kopplung sind praktisch bestätigt. Native Foundry-Anmeldung, zentrale Thread-/Attachment-Archive, Workflow-Engine und Sandboxes bleiben geplant.

Nächster Pflichtblock ist **G3: reale Worker-Ausführung** einschließlich Codex-Bindung, idempotentem Launch, bestätigtem Ergebnis/Stop und Workspace-Recovery. Danach folgt der Factory-MVP mit P18b, P47 und zentraler Persistenz P38a/P38b vor dem ersten Dispatch. Der [Umsetzungsplan](implementation-plan.md#erledigte-implementierung-und-verbleibende-abnahmen) trennt erledigten Code von offenen G1-/G2-/G3-Abnahmen. Keine vorsorgliche Codex-Installation im Main-Container; Agenten laufen auf dem dedizierten Worker.

## Arbeitsweise

Jedes Arbeitspaket erhält einen eigenen Branch, fokussierte Commits und einen PR zum Fork. Die IDs P01–P60 sind Planungsschlüssel, keine GitHub-PR-Nummern. Erledigter Umfang und offene Abnahmen stehen auf Maintainerwunsch im Umsetzungsplan; konkrete Entscheidungen und Nachweise bleiben im zugehörigen Issue/PR. Ein Gate wird mit den tatsächlich geprüften Commit-/Build-Ständen belegt.

Die Maintainer-Vorgaben stehen in [AGENTS.md](../../AGENTS.md). Ein automatischer PR-Check, manuelle Artefakt-Builds bei Bedarf; keine zusätzliche CI-Matrix. Implementierungsnotizen und temporäre Versuchsergebnisse bleiben außerhalb des Repositories. Die ausdrücklich angeforderten Architektur-, Deployment- und Umsetzungsdokumente sind versionierte Ausnahmen davon.

Das abgeschlossene [Issue #13](https://github.com/niklaskastning/foundry/issues/13) archiviert die bisherigen Integrations- und Windows-Nachweise. Offene Punkte wurden in den Umsetzungsplan übernommen. Die dauerhafte Freigabe für Deployments einschließlich offener PRs auf diesen Entwicklungs-VPS steht in [AGENTS.md](../../AGENTS.md#development-vps-and-agent-autonomy). Ein Deployment ersetzt keine Gate-Abnahme; ein Merge benötigt weiterhin einen ausdrücklichen Auftrag.
