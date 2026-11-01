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

Vorhanden sind das isolierte Linux-Main-Deployment, Web und Browser-Pairing, eigene Build-Einstiege sowie inzwischen Instanz-Descriptor, PostgreSQL-Anbindung und Access-Session-Bausteine. Instanz-Gateway, automatische Device-Discovery, Workflow-Engine und Sandbox-Verwaltung sind noch geplant. Windows-Build-Konfiguration bedeutet noch keine bestandene Windows-Laufzeitabnahme.

Der nächste Entwicklungsabschnitt ist **G1: Instanzeinstieg und Anmeldung**. Die vorhandenen Identitäts-/Persistenz-/Access-Bausteine werden bis zum praktisch nachgewiesenen Web-/Windows-Anmeldeweg integriert; ihr Vorhandensein allein schließt G1 nicht ab. G2 prüft anschließend den ausgehenden Device-Transport. Keine vorsorgliche Codex-Installation im Main-Container und kein separates Connect-/Clerk-Deployment.

## Arbeitsweise

Jedes Arbeitspaket erhält einen eigenen Branch, fokussierte Commits und einen PR zum Fork. Die IDs P01–P60 sind Planungsschlüssel, keine GitHub-PR-Nummern. Konkreter Status, Entscheidungen und Nachweise leben im zugehörigen Issue/PR; dieser Ordner ist kein zweites Fortschrittsboard. Ein Gate wird mit den tatsächlich geprüften Commit-/Build-Ständen belegt.

Die Maintainer-Vorgaben stehen in [AGENTS.md](../../AGENTS.md). Ein automatischer PR-Check, manuelle Artefakt-Builds bei Bedarf; keine zusätzliche CI-Matrix. Implementierungsnotizen und temporäre Versuchsergebnisse bleiben außerhalb des Repositories. Die ausdrücklich angeforderten Architektur-, Deployment- und Umsetzungsdokumente sind versionierte Ausnahmen davon.

Die ausdrücklich vorgezogene Entwicklung von P06–P08 und die später nachzuholenden Windows-/G1-/Integrationsnachweise werden in [Tracking-Issue #13](https://github.com/niklaskastning/foundry/issues/13) geführt. Vor Weiterarbeit dieses Issue und seine Paket-PRs lesen; Entwicklungsfreigabe ist keine Gate-Abnahme oder Deployment-Freigabe.
