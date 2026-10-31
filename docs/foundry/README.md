# Foundry-Entwicklung

Einstieg für die Weiterentwicklung unseres dauerhaften T3-Code-Forks. Foundry soll eine selbst gehostete Single-User-Instanz mit einer Hauptdomain, registrierten Devices, Automation und später Sandboxes werden. Die Main Node steuert; ein eigener Host-Worker führt zunächst Agenten aus.

## Wo anfangen?

| Dokument                                 | Zweck                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| [Architektur](architecture.md)           | Produktumfang, Zuständigkeiten, Workflow-Semantik, Isolation und vorhersehbare Risiken |
| [Deployment-Design](deployment.md)       | Instanzanmeldung, Gateway-Vertrauen, Cloudflare, Persistenz und Hosting-Grenzen        |
| [Umsetzungsplan](implementation-plan.md) | PR-große Arbeitspakete, Abhängigkeiten, Prüfgates und Handoffs                         |
| [Betrieb](operations.md)                 | Tatsächlich vorhandenen Grundbetrieb bauen, starten, koppeln und wiederherstellen      |
| [Fork-Wartung](maintenance.md)           | Branch/Commit/PR, Upstream-Integration und sparsamer Actions-Betrieb                   |

Architektur und Deployment erklären **was und warum**; der Umsetzungsplan besitzt **Reihenfolge und Abnahme**. Nur der Betriebsleitfaden beschreibt vorhandene Bedienwege. Ein Arbeitspaket im Plan ist keine Implementierungszusage für den aktuellen Build.

## Vorhandener Stand und nächster Schritt

Vorhanden sind das isolierte Linux-Main-Deployment, Web und Browser-Pairing, vorbereitete PostgreSQL-Datenbanken sowie eigene Build-Einstiege. Instanz-Gateway, automatische Device-Discovery, Workflow-Engine und Sandbox-Verwaltung sind noch geplant. Windows-Build-Konfiguration bedeutet noch keine bestandene Windows-Laufzeitabnahme.

Der nächste Entwicklungsabschnitt ist **G1: Instanzeinstieg und Anmeldung**. Zuerst werden Version/Identität und zentrale Persistenz vorbereitet; danach wird der Access-Anmeldeweg auf Windows praktisch nachgewiesen. G2 prüft anschließend den ausgehenden Device-Transport. Keine vorsorgliche Codex-Installation im Main-Container und kein separates Connect-/Clerk-Deployment.

## Arbeitsweise

Jedes Arbeitspaket erhält einen eigenen Branch, fokussierte Commits und einen PR zum Fork. Die IDs P01–P46 sind Planungsschlüssel, keine GitHub-PR-Nummern. Konkreter Status, Entscheidungen und Nachweise leben im zugehörigen Issue/PR; dieser Ordner ist kein zweites Fortschrittsboard. Ein Gate wird mit den tatsächlich geprüften Commit-/Build-Ständen belegt.

Die Maintainer-Vorgaben stehen in [AGENTS.md](../../AGENTS.md). Ein automatischer PR-Check, manuelle Artefakt-Builds bei Bedarf; keine zusätzliche CI-Matrix. Implementierungsnotizen und temporäre Versuchsergebnisse bleiben außerhalb des Repositories. Die ausdrücklich angeforderten Architektur-, Deployment- und Umsetzungsdokumente sind versionierte Ausnahmen davon.
