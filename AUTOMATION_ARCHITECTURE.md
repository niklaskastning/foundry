# T3 Code Automations – Architektur- und Umsetzungsentwurf

Stand: 31. Oktober 2026 · untersuchter Repository-Stand: `d2d1e4f50e`

Status: Diskussionsentwurf. Dieses Dokument beschreibt vorgeschlagene Erweiterungen, keine bereits implementierte Funktion. Auf ausdrücklichen Wunsch liegt der Plan im Repository; er wird nicht automatisch committed. „Foundry“ bezeichnet hier das beschriebene frühere Projekt, keine angenommene Microsoft-Produktintegration.

## 1. Empfehlung

T3 Code sollte eine **dauerhafte Automation-Schicht oberhalb seiner bestehenden Thread- und Provider-Ausführung** erhalten. Sie verwaltet Workflow-Versionen, Trigger, Step-Abhängigkeiten, Parallelität, Ausführungsziele und Ergebnisse. Jeder Agent-Step führt zu einem normalen T3-Thread, dessen Gespräch, Werkzeuge, Änderungen und Prüfungen zugänglich bleiben.

**Festgelegte Produktrichtung: dauerhafter Fork von T3 Code mit regelmäßiger Übernahme von Upstream-Änderungen.** Die Automation-Erweiterung erhält eigene Module, Contracts und Persistenz. Wenige ausdrücklich benannte Integrationsstellen verbinden sie mit T3. Leicht integrierbare Upstream-Updates sind ein Architektur- und Abnahmekriterium jeder Etappe; eine spätere Aufnahme des Gesamtfeatures in Upstream ist keine Voraussetzung.

Die erste Version läuft als Erweiterung von `apps/server` auf der vorhandenen VPS hinter einer eigenen Cloudflare-Domain. Diese dauerhaft verfügbare T3-Umgebung übernimmt die zentrale Automation-Steuerung. Ein eigenes Connect-Deployment auf Basis von `infra/relay` übernimmt Anmeldung, Maschinenverzeichnis und Verbindungsaufbau für die Fork-Clients. Agenten laufen auf ausdrücklich ausgewählten Ausführungsmaschinen; die VPS dient standardmäßig der Steuerung. Echte kurzlebige Sandboxes folgen als zusätzlicher Ausführungstyp. Web und Windows-Desktop bekommen denselben Automation-Bereich. Mobile bleibt zunächst unverändert; eine spätere Integration kann dieselben Contracts verwenden.

**PostgreSQL ist ab der ersten Version gesetzt:** für Automation und für das eigene Connect-Verzeichnis, mit getrennten logischen Datenbanken, Rollen und Migrationen. Die vorhandene lokale SQLite-Persistenz der T3-Environments bleibt für deren Threads und Sessions bestehen; der Fork portiert nicht nebenbei den gesamten Upstream-Server auf PostgreSQL. Ein externer Message Bus, Kubernetes und eine zweite Workflow-Engine sind keine Voraussetzung.

Der konkrete Betriebs- und Repository-Änderungsplan steht in [FORK_DEPLOYMENT.md](FORK_DEPLOYMENT.md). Er beschreibt die VPS, Cloudflare, das eigene Connect, PostgreSQL, Client-Konfiguration, Releases und die Reihenfolge der dafür notwendigen Änderungen. Dieses Dokument bleibt für die Workflow-Domäne und Ausführungssemantik maßgeblich.

**Erster sinnvoller Durchstich:** Ein freigegebenes GitHub-Issue startet Analyse → Implementierung → Prüfung in einem Worktree auf einer ausgewählten Maschine. Jeder Step ist einsehbar; nach Freigabe wird genau ein PR veröffentlicht. Neustarts und doppelte Webhooks erzeugen keine zusätzlichen Implementierungen oder PRs.

### Anfänglicher Plattform- und Betriebsumfang

Die Gesamtarchitektur einschließlich eigenem Connect, Maschinenverzeichnis, Workflows und späteren Swarms/Sandboxes bleibt erhalten. Der Aufwand wird zunächst über die unterstützten Plattformen und die Distribution begrenzt:

- **Linux-VPS:** Erweiterter T3-Server samt Web-Build und PostgreSQL per Docker Compose. Connect bleibt ein eigener Cloudflare Worker auf Basis des vorhandenen Relay-Codes.
- **Windows-Desktop:** Eigener Fork-Build mit derselben React-Oberfläche wie Web. Der vorhandene Modus ohne lokale Umgebung (`localEnvironmentEnabled=false`) erlaubt die Nutzung als Remote-Client; ein Windows-Port des neuen Automation-Backends ist dafür nicht erforderlich.
- **Ausführung:** Zunächst ein Linux-Ausführungsziel. Es darf bei ausreichenden Ressourcen auf derselben VPS liegen, logisch getrennt und mit begrenzter Parallelität. Remote-Dispatch wird trotzdem geprüft; dafür genügt ein zweites isoliertes Linux-Environment auf dieser VPS, ein zusätzlicher Rechner ist keine Voraussetzung. Windows als Worker ist eine spätere, getrennte Entscheidung.
- **Distribution:** Ein Linux-Image für die tatsächliche VPS-Architektur und ein interner Windows-Desktop-Build. Manuelle, reproduzierbare Updates genügen anfangs; keine macOS-/Linux-Desktop-Artefakte, eigene npm-Veröffentlichung oder vollständige Release-Matrix als Startbedingung.
- **Mobile:** Keine neuen Ansichten, Login-Anpassungen, App-Builds, Store-Releases, Push-Integration oder Mobile-Abnahme in den ersten Etappen. Gemeinsame Contracts werden additiv erweitert, damit unveränderte Clients nicht unnötig brechen. Daraus folgt keine Zusage, dass offizielle mobile Apps den eigenen Connect bereits unterstützen.

Eigene Datenverzeichnisse, App-Identität und Schutz vor versehentlichen Updates auf offizielle T3-Builds sind auch bei manueller Distribution erforderlich. Diese Eingrenzung ersetzt keine Architekturbausteine und verschiebt das zentrale Connect-Ziel nicht.

## 2. Was das Repository bereits mitbringt

Die folgende Bestandsaufnahme basiert auf Code und Dokumentation dieses Checkouts. Die Dateilinks führen zum vorhandenen Code; spätere Abschnitte kennzeichnen neue Bausteine als Vorschlag.

| Bereich                       | Vorhandene Grundlage                                                                                                                                                                                                                                                        | Für das Ziel noch erforderlich                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Zeitpläne und Webhooks        | [ScheduledTaskService](apps/server/src/scheduledTasks/ScheduledTaskService.ts), [Schemas](packages/contracts/src/scheduledTask.ts): Intervalle, feste Uhrzeiten/Wochentage, Webhooks, Filter, Deduplizierung, Coalescing, Zustellhistorie                                   | Trigger auf versionierte mehrstufige Workflows abbilden; eigene Run-Historie; explizite Zeitzonen und Nachholregeln |
| Thread-Start und Workspace    | [ThreadLaunchService](apps/server/src/orchestration-v2/ThreadLaunchService.ts): Projektwurzel, vorhandener oder neuer Worktree, Provider-/Modellauswahl                                                                                                                     | Step-Zuordnung, mehrere Repositories pro Step, Sandbox-Lebenszyklus                                                 |
| Dauerhafte Orchestrierung     | [Orchestrator](apps/server/src/orchestration-v2/Orchestrator.ts), [EventSink](apps/server/src/orchestration-v2/EventSink.ts), [EffectWorker](apps/server/src/orchestration-v2/EffectWorker.ts): Commands, Events, Projektionen, Receipts und Outbox                         | Workflow-Zustandsmaschine und Step-Versuche mit denselben Zuverlässigkeitsprinzipien                                |
| Andere Maschinen              | [PeerLinks](apps/server/src/peer/PeerLinks.ts), [RemoteDelegation](apps/server/src/peer/RemoteDelegation.ts)                                                                                                                                                                | Workflow-eigene Dispatch-Aufträge, Kapazitäten, Leases, Worker-Auswahl, provisionierte Sandboxes                    |
| Agenten-Workflows             | [OrchestrationV2SubagentWorkflow](packages/contracts/src/orchestrationV2.ts), [WorkflowOpeningBlock](apps/web/src/components/chat/WorkflowOpeningBlock.tsx)                                                                                                                 | Die vorhandenen Provider-Abläufe sind keine zentrale Bibliothek frei definierbarer Automationen                     |
| Source Control                | [Registry](apps/server/src/sourceControl/SourceControlProviderRegistry.ts), `packages/source-control-*`, darunter GitHub und Azure DevOps                                                                                                                                   | Ereignisadapter, GitHub-App-Installation, begrenzte Step-Credentials und Automation-Publish-Aktionen                |
| Credentials                   | [ProviderHost](packages/provider-core/src/server/ProviderHost.ts), [ServerSecretStore](apps/server/src/auth/ServerSecretStore.ts), [SecretResolver](apps/server/src/secrets/SecretResolver.ts)                                                                              | An Workflow/Step/Repository gebundene Credential-Ausgabe, Erneuerung und Widerruf                                   |
| Skills und Provider-Instanzen | Provider-Driver und vorhandene Skill-Erkennung; beispielsweise [CodexManagedProvider](apps/server/src/provider/Drivers/CodexManagedProvider.ts)                                                                                                                             | Versionierte Agent-Vorlagen und zentral verwaltete, reproduzierbar auslieferbare Skill-Bundles                      |
| Oberfläche                    | [ScheduledTasksSettings](apps/web/src/components/settings/ScheduledTasksSettings.tsx), [ThreadAutomationsPanel](apps/web/src/components/chat/ThreadAutomationsPanel.tsx), [Mobile Scheduled Tasks](apps/mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx) | Automation-Übersicht, Workflow-Editor, Run-/Step-Ansicht und Maschinenstatus                                        |

### Drei wichtige Grenzen des Bestands

1. `ScheduledTaskService` setzt den Status nach erfolgreichem `launch` beziehungsweise `sendToThread` auf `succeeded`. Das bestätigt die Übergabe des Auftrags, nicht den fachlichen Erfolg des Agenten. Ein Workflow darf diesen Status nicht als Step-Ergebnis verwenden.
2. Ein Git-Worktree trennt Arbeitsverzeichnisse und Branches. Er isoliert weder Prozesse noch Credentials oder Netzwerke. Auch ein Peer-Link ist laut [Remote-Architektur](docs/internals/remote.md) Routing, keine Sandbox.
3. Das gehostete Web-Frontend ist ein Client. Es ist heute keine zentrale Steuerung für alle verbundenen Umgebungen. Eine dauerhafte Automation-Steuerung braucht einen ausdrücklich gewählten Backend-Owner; ein offener Browser darf nicht Voraussetzung für die Ausführung sein.

## 3. Umfang und Annahmen

Festgelegt sind ein dauerhafter Fork, die vorhandene VPS als Main Node, eine eigene Cloudflare-Domain, PostgreSQL für die zentrale Plattform und ein gemeinsamer Connect-Einstieg für die Fork-Clients. Der Entwurf nimmt zunächst einen Betreiber oder ein vertrauenswürdiges Team an. Es gibt zunächst einen aktiven Workflow-Koordinator pro Automation-Datenbestand. Fremde, voneinander isolierte Mandanten auf gemeinsamem Hosting sind eine spätere Produktentscheidung.

Zum Zielumfang gehören:

- Manuelle Starts, tägliche/wöchentliche Zeitpläne und externe Ereignisse aus GitHub, Azure DevOps und Jira Service Management.
- Versionierte Workflows mit sequenziellen und parallelen Steps, Bedingungen, Freigaben und begrenzten Wiederholungen.
- Wiederverwendbare Agent-Vorlagen oder vollständig im Step definierte Agenten.
- Wahl einer festen Maschine oder eines geeigneten Worker-Pools.
- Gemeinsamer Workspace pro Run, eigene Workspaces pro Step oder pro Repository.
- Mehrere Agenten über mehrere Repositories, einschließlich eines Agenten mit mehreren Repositories.
- Dauerhafte Ergebnisse, nachvollziehbare Ausführung und explizites langfristiges Memory.

Ein öffentlicher Workflow-Marktplatz, beliebiger JavaScript-Code in der Steuerung, automatische Infrastrukturabrechnung, eine freie graphische Canvas und unbegrenzte autonome Swarms sind keine Voraussetzungen für die erste Version.

### 3.1 Relevante Produktvision aus dem ursprünglichen Foundry

Grundlage ist die gelesene [Foundry-Produktvision](../foundry-platform/docs/PRODUCT_VISION.md), eingeordnet anhand der vom Benutzer genannten Referenz <t3-thread://v2/0752022b-4709-4784-bdc5-55847feed7fa/593e557f-4791-4fde-a634-3ff160b33bf0>. Der Dateiverweis führt zum separaten lokalen Referenzprojekt und ist keine Build- oder Laufzeitabhängigkeit. Die folgenden Punkte beschreiben die für diesen Fork ausgewählte Vision, keine Zusage über bereits implementierte oder abgenommene Foundry-Funktionen.

**Produktziel:** Aus einem Auftrag werden mit wenig manueller Koordination geprüfte, nachvollziehbare Änderungen über eines oder mehrere Repositories. T3 bleibt die Oberfläche, in der Menschen die beteiligten Agenten beobachten, steuern und deren Ergebnisse prüfen.

1. **Der Auftrag steht über dem einzelnen Repository.** Ein Issue, Jira-Ticket, Azure-Work-Item oder manuell formulierter Auftrag kann mehrere Repositories betreffen. Der Ablageort eines Tickets begrenzt nicht den Implementierungsumfang. Ein normalisierter Auftragsbezug verbindet Trigger, Runs, betroffene Repositories und Ergebnisse; ein Auftrag kann mehrere Runs und Überarbeitungen haben.
2. **Ein nachvollziehbarer Ablauf vom Verstehen bis zur Übergabe.** Je nach Workflow gehören Spezifikation, Repository-Analyse, Planung, Implementierung, Review, begrenzte Korrekturschleifen, Tests und Dokumentation dazu. Nicht jeder Auftrag braucht jeden Schritt. Ergebnis ist eine überprüfbare Änderung mit klaren Akzeptanzkriterien statt lediglich ein beendeter Agentenlauf.
3. **Wiederverwendbare Spezialisten mit Anpassungen pro Step.** Basis-Agenten definieren Rolle, Instruktionen, Skills und benötigte Fähigkeiten. Workflow-Schritte ergänzen ihren konkreten Auftrag. Ein Reviewer, Implementer und Analyst können unterschiedliche Provider und Modelle nutzen, ohne dass sich dadurch die Workflow-Steuerung ändert.
4. **Koordinierte Parallelität mit klaren Übergaben.** Ein Plan kann Aufgaben auf mehrere Agenten und Repositories verteilen. Abhängigkeiten, begrenzte Parallelität, Teilfehler und Zusammenführung bleiben Aufgaben der Plattform. Ein Agent kann die Aufteilung vorschlagen; die Plattform prüft Umfang und Rechte, bevor Arbeit startet.
5. **Verhalten und Betriebszugriff bleiben getrennt.** Workflows, Agenten, Skills und Ergebnisformate sind versionierbare Definitionen. Maschinen, konkrete Repository-Zuordnungen, Konten und Secrets werden zentral gebunden. Ein Run hält seine wirksame Konfiguration fest; ein späteres Bearbeiten einer Vorlage verändert ihn nicht rückwirkend. Ein eigenes Konfigurations-Git-Repository ist eine mögliche Verwaltung, aber keine Voraussetzung für unsere erste Version.
6. **Menschen können während der Ausführung eingreifen.** Zusätzliche Anweisungen, Antworten auf Rückfragen, Pausen und Freigaben werden dem richtigen Auftrag und Step zugeordnet. Ein neuer Kommentar muss nicht automatisch den gesamten Workflow neu starten. Bereits ausgeführte Aktionen bleiben historisch sichtbar; Änderungen an Umfang oder Ausgabe können eine neue Freigabe erforderlich machen.
7. **Der bestehende Arbeitsort bleibt nutzbar.** Bei extern ausgelösten Aufträgen bleibt das Ticket der menschliche Bezugspunkt für Ziel, Klärungen und kompakte Ergebnislinks. T3 hält die detaillierte Ausführung und Bedienung bereit. Manuelle Aufträge dürfen vollständig in T3 leben; ein künstliches GitHub-Issue oder zusätzliches Kontext-Repository ist nicht erforderlich. Synchronisation erzeugt keine zweite konkurrierende Ticket-Wahrheit.
8. **Lückenlose Verknüpfung der aufgezeichneten Ergebnisse.** Vom Auftrag führt der Weg zu Workflow-Version, Run, Step, Agent, Maschine/Sandbox, Repository, Commit, Review, Test und PR. Nach dem Ende einer Sandbox bleiben diese Nachweise zugänglich. Jeder Step liefert explizite, prüfbare Artefakte für seine Nachfolger.
9. **Memory als belegbare Unterstützung.** Wiederkehrende Erkenntnisse und Entscheidungen können zukünftigen Runs helfen, behalten aber Herkunft und Gültigkeitsbereich. Aktueller Code, ausdrücklich erteilte Anweisungen und aktuelle Ticket-/CI-Ergebnisse haben Vorrang vor abgeleitetem Wissen. Memory ersetzt weder die Ausführungshistorie noch die Prüfung des aktuellen Repository-Stands.
10. **Kontrollierte Übergabe statt unbegrenzter Autonomie.** Als anfänglicher Produktumfang endet der Ablauf bei geprüften Änderungen und einem oder mehreren zur menschlichen Entscheidung bereiten PRs. Automatisches Mergen oder Produktionsdeployment wird daraus nicht abgeleitet. Repository- und Tool-Zugriffe werden passend zur jeweiligen Rolle vergeben; eine Agent-Vorlage erweitert keine tatsächlichen Berechtigungen.

Für den bestehenden Plan bedeutet das vor allem drei Ergänzungen: einen repositoryübergreifenden Auftragsbezug oberhalb einzelner Runs, gezieltes Weiterreichen neuer menschlicher Informationen an laufende Steps und kompakte Rückmeldungen zum ursprünglichen Ticket. Diese Funktionen werden in die vorhandenen Services und Etappen eingeordnet; sie verlangen keine zweite Agentenplattform neben T3.

**Keine Übernahmevorgabe** sind Foundrys Python-/ACP-/OpenHands-Laufzeit, Kubernetes-/K3s-Aufteilung, eigene CLI, Authentifizierung, UI, Datenbankschemas oder Release-Prozesse. Auch ältere Audit-Ergebnisse und Testzahlen aus Foundry sind keine Abnahme unserer Umsetzung. VPS, PostgreSQL, eigenes Connect, T3-Provider-Adapter und die Fork-Update-Strategie bleiben wie hier geplant. Die Referenz dient der Produktausrichtung, nicht einer technischen Portierung oder einer Migration der laufenden Foundry-Installation.

## 4. Zielarchitektur und Verantwortlichkeiten

### 4.1 Main Node: eine T3-Umgebung als Automation-Owner

Die Main Node enthält logisch folgende Funktionen. Sie müssen zunächst keine separaten Prozesse sein:

- **AutomationService:** Entwürfe, veröffentlichte Versionen, Starts, Pausen, Abbrüche und Freigaben.
- **Trigger-Ingress:** Webhook-Annahme, Zeitplan-Auslösung und gegebenenfalls Polling-Connectoren.
- **Workflow-Steuerung:** Entscheidungen über ausführbare Steps, Parallelitätsgrenzen und nächste Zustände.
- **Dispatch:** Dauerhafte Aufträge an lokale oder entfernte Ausführungsziele.
- **Agent-/Skill-Katalog:** Versionen, Kompatibilität und Berechtigungen.
- **Credential Broker:** Ausgabe nur der für einen Step erlaubten Zugriffe.
- **Artefakt- und Memory-Verwaltung:** Persistente Ergebnisse außerhalb kurzlebiger Workspaces.

Die Main Node darf optional selbst ein Worker sein. Für den vorgesehenen VPS-Betrieb laufen Agenten standardmäßig auf registrierten Maschinen, damit Builds und Agent-Prozesse die Steuerung und Datenbank nicht verdrängen. Für den schlanken Start können Main Node und ein begrenzter Linux-Worker auf derselben VPS laufen; die verfügbare CPU-/RAM-Kapazität entscheidet über Parallelität und spätere Auslagerung.

Eine Automation hat genau einen Owner. Ein Client kann mehrere Owner sehen, aber kein Browser synchronisiert heimlich deren Definitionen. Export/Import und später explizite Replikation bleiben gesonderte Funktionen.

Das eigene Connect führt das autorisierte Maschinenverzeichnis. Ein Client meldet sich dort einmal an und sieht seine registrierten Umgebungen einschließlich der Main Node. Die Main Node kennzeichnet daraus die ausdrücklich als Automation-Worker freigegebenen Ziele. Ein Peer-Link allein veröffentlicht keine Maschine an alle Clients. Maschinenregistrierung, Client-Zugriff und Automation-Dispatch bleiben getrennte, aufeinander bezogene Berechtigungen.

### 4.2 Worker: Ausführung mit klarer Maschinenzuordnung

Ein dauerhaftes T3-Environment führt Agenten über die vorhandenen Provider-Adapter aus. Es behält seine eigene Authentifizierung, Projekte, Dateipfade und Thread-Historie. Die Steuerung übermittelt logische Repository-Referenzen und einen Auftrag; der Worker löst die lokalen Pfade auf.

Für Automation kommen hinzu:

- Worker-Identität, Fähigkeiten und aktuelle Kapazität.
- Eignung nach Provider, Modellzugang, Betriebssystem, Architektur, Ressourcen, Labels und Isolationstyp.
- Dauerhafte Annahme eines Dispatch-Auftrags mit eindeutigem Schlüssel.
- Lebenszeichen, Lease-Erneuerung, Abbruch und Wiederanmeldung nach Verbindungsabbruch.
- Rückgabe von Thread-Referenz, Fortschritt, Ergebnismanifest und Artefakten.

`environmentId` ist eine konkrete Maschine/Umgebung; `poolId` bezeichnet eine erlaubte Menge geeigneter Ziele. Bei fester Zielwahl wartet der Run auf diese Maschine. Er wechselt nicht stillschweigend auf eine andere Maschine oder auf ein anderes Provider-Konto.

Peer-Verbindungen und Authentifizierung sollen wiederverwendet werden. Die heutige `RemoteDelegation` setzt jedoch einen delegierenden Agent-Thread voraus. Eine Workflow-Engine sollte keinen künstlichen Eltern-Agenten starten müssen: Die benötigten Launch-/Follow-/Cancel-Funktionen werden über einen servicebasierten Dispatch-Pfad zugänglich gemacht.

Bestehende Peer-Rechte erlauben nicht automatisch Projektanlage, Setup-Skripte oder Weiterdelegation. Automation-Worker benötigen ausdrücklich passende, begrenzte Fähigkeiten; bestehende Link-Grenzen werden nicht für alle Verbindungen gelockert.

### 4.3 Kurzlebige Sandboxes: zuerst vorhandene Laufzeit kapseln

Für echte Sandboxes empfehle ich zunächst **eine isolierte T3-Ausführungsumgebung pro Sandbox**. Darin laufen T3 und die vorhandenen Provider-Adapter zusammen mit den Checkouts. Ein dauerhafter Supervisor auf dem Worker provisioniert, verbindet, überwacht und beendet diese Umgebung.

So bleiben Shell, Git, Provider-Dateipfade, MCP und Checkpoints innerhalb derselben Ausführungsgrenze. Nur den Provider-Prozess in einen Container zu verschieben, während Git und Dateizugriffe auf dem Host bleiben, würde diese Grenze verletzen und viele Adapteränderungen erfordern.

Der Supervisor führt einen Provisioning-Auftrag mit stabiler Ressourcen-ID aus, sodass ein Retry keine zweite Sandbox erzeugt. Er ist außerhalb der Sandbox, besitzt die Infrastrukturrechte und verwaltet deren Lebensdauer. Die Sandbox erhält weder den Docker-Socket noch einen administrativen Host-Zugang.

Der erste Sandbox-Adapter sollte genau einen Betriebsweg implementieren, etwa OCI-Container auf einem dedizierten Linux-Worker. Für fremden Code mit höheren Isolationsanforderungen folgt ein VM-/MicroVM-Adapter. Container sind nicht automatisch eine ausreichende Mandantengrenze. Eine bestimmte Cloud ist für das Datenmodell nicht erforderlich.

Der Preis dieser Entscheidung ist zusätzlicher Startaufwand und ein neuer Archivierungsvertrag. Das ist für die erste Sandbox-Version überschaubarer als eine universelle Remote-Shell-Abstraktion für alle Provider. Erst nach Messung wäre eine schlankere Runner-Laufzeit sinnvoll.

### 4.4 Persistenz und Transport

Die Main Node besitzt Definitionen, Trigger-Inbox, Run-/Step-Zustände, Dispatch-Outbox und Artefaktverweise. Dauerhafte Worker besitzen ihre Thread-Ereignisse. Bei kurzlebigen Umgebungen werden diese Ereignisse zusätzlich fortlaufend zur Main Node übertragen und dort als Archiv gespeichert.

Zunächst läuft PostgreSQL auf der VPS mit persistentem Volume und zwei logischen Datenbanken: `fork_automation` und `fork_connect`. Die Automation-Steuerung greift über einen begrenzten lokalen Connection-Pool zu; das eigene Connect-Relay über den in [FORK_DEPLOYMENT.md](FORK_DEPLOYMENT.md) beschriebenen privaten Datenbankzugang. Ausführungsmaschinen verwenden authentifizierte APIs und erhalten keine zentrale Datenbankverbindung. Große Transkripte, Anhänge, Git-Bundles und Testergebnisse liegen in einem getrennten Blob-Speicher: anfangs ein dauerhaftes Verzeichnis, später bei Bedarf Object Storage.

Innerhalb der Automation-Datenbank werden Run-Zustand und Dispatch-Outbox atomar gespeichert. Zwischen Automation und T3 gibt es bewusst keine gemeinsame Datenbanktransaktion: Eine Outbox liefert den Auftrag mit stabilem Command-Schlüssel an den T3-Adapter; dieser bestätigt beziehungsweise gleicht den vorhandenen Thread ab. Dieses Protokoll gilt lokal ebenso wie auf entfernten Workern. Es verhindert, dass der Fork direkt in Upstream-Projektionstabellen schreiben muss.

Ein WebSocket liefert schnelle Benachrichtigungen. Die dauerhaften Datensätze tragen die Zustellgarantie: nach einem Neustart oder verlorenen Signal findet ein Worker ausstehende Arbeit erneut. Ein Queue-Scan ist dabei zulässig; fachlicher Workflow-Zustand darf nicht nur im Speicher liegen.

Ein externer Broker wird erst erforderlich, wenn Messungen oder Betriebsanforderungen ihn rechtfertigen, etwa mehrere unabhängige Ingress-Dienste oder sehr hohe Ereignismengen. Auch dann bleiben PostgreSQL und Idempotenzregeln maßgeblich. PostgreSQL ist bereits der Ausgangspunkt; Replikation, Failover und mehrere Koordinatoren sind getrennte spätere Betriebsentscheidungen.

## 5. Domänenmodell

„Provider“ bleibt in T3 der Agent-Runtime vorbehalten. Für GitHub-/Jira-Ereignisse verwendet die Automation-Schicht den Begriff **Connector**; für die Codeplattform **Source-Control-Host**.

| Entität                                  | Bedeutung                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WorkflowDefinition` / `WorkflowVersion` | Bearbeitbarer Entwurf und unveränderliche veröffentlichte Version mit Step-Graph                                  |
| `TriggerBinding`                         | Verbindet Zeitplan, manuelles Ereignis oder Connector-Ereignis mit einer Workflow-Version und einem Input-Mapping |
| `TriggerEvent`                           | Persistierter Eingang mit Herkunft, Zustell-ID, Zeitpunkten und Payload-Referenz                                  |
| `AgentDefinition` / `AgentVersion`       | Wiederverwendbare Vorlage: Provider-Wunsch, Modell, Instruktionen, Skills, Tool- und Ressourcenanforderungen      |
| `ExecutionTarget`                        | Konkretes Environment oder Pool; zulässige Provider-Instanzen und Fähigkeiten                                     |
| `WorkflowRun`                            | Ein Start mit festgehaltener Workflow-Version, Input, Repository-Auswahl und Konfigurations-Snapshot              |
| `StepRun`                                | Konkreter Step, bei Fan-out zusätzlich mit stabilem Element-Schlüssel                                             |
| `StepAttempt`                            | Ein Ausführungsversuch mit Lease, Thread-Referenz, Ergebnis und Fehlerursache                                     |
| `WorkspaceAllocation`                    | Run-/Step-/Repository-bezogener Workspace mit Basis-Commit und Ausgabe-Revision                                   |
| `Artifact`                               | Unveränderliches Ergebnis mit Typ, Hash, Herkunft, Speicherort und Zugriffsschutz                                 |
| `MemoryEntry`                            | Versioniertes langfristiges Wissen mit Gültigkeitsbereich und Herkunft                                            |
| `CredentialGrant`                        | Genehmigte Nutzung einer Credential-Referenz; keine Zugangsdaten im Workflow-Dokument                             |

Eine Thread-Referenz enthält mindestens `environmentId` und `threadId`, zusätzlich die zugehörigen T3-Run-/Turn-IDs. IDs werden nicht zwischen Maschinen als global gleichbedeutend behandelt.

Agent-Vorlagen sind Konfiguration, keine ständig laufenden Agenten. Standardmäßig bekommt jeder StepAttempt einen neuen Thread. Ein Folgeschritt erhält gezielt ausgewählte Artefakte und Zusammenfassungen. Gesprächsfortsetzung ist eine optionale, explizite Einstellung; sie setzt kompatiblen Provider, erreichbare Session und passende Rechte voraus.

Beim Run-Start werden Workflow, Agenten, Skills und statische Repository-Auswahl auf konkrete Versionen aufgelöst. Bei dynamischem Fan-out wird die erzeugte Liste nach einmaliger validierter Ermittlung ebenfalls dauerhaft eingefroren. Credential-Werte bleiben außerhalb dieses Snapshots und werden bei Nutzung aktuell autorisiert.

## 6. Workflow-Ausführung und Fehlersemantik

### 6.1 Steps und Graph

Die erste Sprache ist deklarativ: Agent-Step, freigegebener Shell-/Test-Step, deterministische Connector-Aktion, Freigabe und Fan-out/Join. Abhängigkeiten bilden einen gerichteten azyklischen Graphen. Bedingungen verwenden eine begrenzte, typisierte Ausdruckssprache über Inputs und Outputs, kein `eval` im Backend.

Ein Script-Step läuft auf einem Worker innerhalb der gewählten Isolation. Repository- oder Benutzer-Code läuft niemals zur Auswertung einer Workflow-Definition in der Main Node.

Schema-Validierung vor Veröffentlichung prüft Zyklen, unbekannte Referenzen, Output-Schemas, maximale Fan-out-Größe, verfügbare Fähigkeiten und widersprüchliche Workspace-Schreibzugriffe. Ein Dry Run zeigt geplante Zuordnung und Berechtigungen, startet aber keine Agenten und veröffentlicht nichts.

### 6.2 Erfolg ist mehr als ein beendeter Agent

Ein Agent-Step ist erst erfolgreich, wenn:

1. Der zugeordnete Provider-Turn tatsächlich erfolgreich beendet ist; eine Zustellbestätigung reicht nicht.
2. Für diesen Versuch notwendige Checkpoints und Nacharbeiten abgeschlossen sind.
3. Der Output sein Schema und die definierten Nachbedingungen erfüllt.
4. Erforderliche Artefakte dauerhaft gespeichert und referenzierbar sind.

Ein Text „Tests erfolgreich“ ersetzt keinen Test-Exitcode. Ein Implementer liefert beispielsweise Commit-/Patch-Referenz und Zusammenfassung; ein Test-Step liefert Exitcode und Bericht; ein Publish-Step liefert die externe PR-Identität.

Freigabefragen eines Providers führen in einen sichtbaren Wartezustand. Für unbeaufsichtigte Runs wird vorher festgelegt, ob solche Anfragen an einen Menschen eskaliert werden oder den Step blockieren. Keine automatische Antwort durch einen versteckten zweiten Agenten.

### 6.3 Zustände und Wiederaufnahme

Run-Zustände: `queued`, `running`, `paused`, `waiting_for_approval`, `cancelling`, `succeeded`, `failed`, `cancelled`. Wartegründe wie `worker_offline`, `provider_limit` oder `credentials_required` sind eigene strukturierte Felder.

Step-Zustände unterscheiden mindestens Abhängigkeiten, Bereitstellung, Agentenlauf, Ergebnisprüfung, Retry-Wartezeit, Freigabe und Terminalzustände. Ein Retry erzeugt einen neuen `StepAttempt`; frühere Versuche bleiben sichtbar.

- **Pause:** Keine neuen Steps starten. Bereits laufende Steps dürfen standardmäßig fertiglaufen; eine sofortige Unterbrechung ist eine eigene Aktion.
- **Fortsetzen:** Startet wieder freigegebene Steps aus dem gespeicherten Zustand.
- **Abbruch:** Persistiert den Abbruchwunsch, stoppt aktive Arbeit und meldet `cancelling`, bis Stop bestätigt oder Ausführungsressourcen zuverlässig beendet sind.
- **Retry:** Wiederholt nur zulässige Fehler und arbeitet von einem ausdrücklich ausgewählten Snapshot. Keine neue Implementierung in einem halb veränderten Workspace ohne Entscheidung.
- **Nachfolgende Steps erneut ausführen:** Verwendet einen neuen Run oder eine explizite neue Ausführungsgeneration; alte Ergebnisse werden nicht rückwirkend umgeschrieben.
- **Workflow-Version ändern:** Wirkt auf neue Starts. Ein laufender Run bleibt auf seiner Version.

Trigger lassen sich deaktivieren und wieder aktivieren; das beendet keine bereits laufenden Runs. Für schon angenommene, noch nicht gestartete Ereignisse wird beim Deaktivieren ausdrücklich zwischen Behalten und Verwerfen gewählt. Definitionen und Agent-Versionen werden zunächst archiviert, solange historische Runs sie referenzieren. Ein erneuter Start erhält eine neue Run-ID und dokumentiert seine Herkunft.

Technische Retry-Regeln unterscheiden vorübergehende Netzwerk-/Rate-Limit-Probleme von fehlender Anmeldung, Testfehlern und ungültiger Konfiguration. Eine begrenzte „Review → Repair“-Schleife ist ein fachlicher Ablauf mit Iterationslimit, kein endloser technischer Retry.

### 6.4 Zustellung, Leases und externe Seiteneffekte

Webhook-Annahme erfolgt nach Authentifizierung und Größenprüfung in eine persistente Inbox. Erst nach Commit wird Erfolg zurückgegeben. Inbox-Verarbeitung schreibt Run-Erstellung und Fortschrittsmarkierung atomar beziehungsweise über stabile Command-Receipts; ein Absturz zwischen Annahme und Start verliert keinen Auftrag.

Ein Dispatch hat einen stabilen Schlüssel aus Run, Step, Fan-out-Element und Attempt. Der Worker speichert seine Annahme vor dem Start und gibt bei Wiederholung dieselbe Thread-Referenz zurück. Ein Timeout des Aufrufers ist kein Beweis, dass kein Agent gestartet wurde.

Jede Lease hat eine monotone Generation. Veraltete Worker-Ergebnisse dürfen keine neueren Ergebnisse überschreiben. Bei Verbindungsverlust wird zuerst abgeglichen; eine neue Ausführung startet erst, wenn die alte beendet oder für schreibende Aktionen wirksam ausgeschlossen ist.

**Lease-Fencing allein verhindert keine Git-Pushes durch bereits ausgegebene Tokens.** Bei direktem Repository-Zugriff braucht es bestätigten Prozess-/Sandbox-Stop, wirksamen Credential-Widerruf oder Ablauf plus abgesicherten Neustart. Für kontrolliertes Publishing ist ein zentral autorisierter Connector-Aufruf einfacher: jeder Schreibaufruf prüft die aktuelle Generation.

Externe Aktionen sind nicht global „exactly once“. PR-Erstellung, Kommentare und Branch-Pushes bekommen jeweils eigene Operationsschlüssel und Reconciliation: nach unklarer Antwort zuerst nach vorhandenem Ergebnis suchen, dann gegebenenfalls wiederholen. Menschliche Freigaben gelten für eine konkrete Revision; neue Änderungen machen sie ungültig.

## 7. Trigger: Webhooks, Zeitpläne und Polling

Automation erhält eigene Trigger-Bindings und einen eigenen, benannten HTTP-Eingang; bestehende Scheduled Tasks behalten ihre Schemas, Semantik und URLs. Wiederverwendbare Schedule-, Signatur-, Filter- und Deduplizierungslogik wird über den T3-Integrationsbereich eingebunden. Falls dafür ein kleiner Service-Hook oder eine Extraktion nötig ist, wird das als begrenzte Upstream-Anpassung dokumentiert. Die große `ScheduledTaskService` wird nicht zum Speicher und Ausführer der neuen Workflow-Domäne umgebaut.

Die Automation-Oberfläche kann bestehende Scheduled Tasks ergänzend anzeigen und zu ihrem Editor verlinken. Eine ausdrückliche spätere Übernahme in einen Workflow deaktiviert die alte Auslösung koordiniert; es dürfen nicht beide Systeme denselben Auftrag ausführen. Der eigene Automation-Eingang besitzt weiterhin die in Abschnitt 6 beschriebene Inbox und Zustellgarantie.

Ein normalisiertes Ereignis enthält Connector-Instanz, externe Delivery-ID, Event-Typ, Repository-/Projekt-/Ticket-Identität, `occurredAt`, `receivedAt`, Actor und Payload-Referenz. Payload und sensible Header werden getrennt behandelt; Tokens landen nicht in der Zustellhistorie.

Trigger können mehrere Workflows ansprechen. Der Deduplizierungsschlüssel muss deshalb Connector-Instanz, Delivery-ID und Trigger-Binding berücksichtigen. Das unterdrückt doppelte Zustellungen, ohne einen zweiten beabsichtigten Workflow zu verhindern.

- **GitHub:** Issue-/PR-Ereignisse und Aktionen wie `opened`, `labeled` oder `synchronize`; Installation, Repository und Signatur prüfen. Für den Einstieg ein ausdrücklich erlaubtes Label statt jedes öffentliche Issue automatisch ausführen.
- **Azure DevOps:** Service Hooks für Work Items und Pull Requests in das gleiche Ereignismodell übersetzen. Diese Ereignisse sind offiziell vorgesehen; die Authentifizierung des Webhook-Eingangs wird im Connector umgesetzt. [Microsoft: Service-Hook-Ereignisse](https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops)
- **Jira Service Management:** Jira-Cloud-Issue-Ereignisse nach Service-Projekt und Request Type zuordnen; fehlende JSM-Felder autorisiert nachladen. Cloud und Data Center sind unterschiedliche Integrationen. Webhook-Registrierung, Wiederzustellung und gegebenenfalls Erneuerung gehören zum Connector-Lebenszyklus. [Atlassian: Jira-Cloud-Webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/)
- **Schedules:** Zeitzone pro Trigger, gespeicherter nächster Termin und eindeutige Termin-ID. Für DST, Server-Ausfall und verpasste Termine werden Regeln festgelegt: überspringen, einmal nachholen oder begrenzt nachholen. Auch Run-Überlappung wird explizit gewählt: warten, überspringen oder zusammenfassen.
- **Polling:** Sinnvoll, wenn Webhooks nicht verfügbar oder nicht öffentlich erreichbar sind, sowie als Abgleich verlorener Ereignisse. Mit persistentem Cursor, überlappendem Abfragefenster, Deduplizierung und Backoff; Cursor erst nach dauerhafter Annahme weiterstellen.

Webhooks lösen das schnelle Erkennen aus. Regelmäßiger Abgleich behebt Lücken. Worker-Lebenszeichen und Queue-Abgleich lösen nochmals ein anderes Problem. Ein Message Bus ersetzt keine dieser drei Aufgaben.

Für öffentliche SaaS-Webhooks erhält die VPS einen HTTPS-Eingang unter der eigenen Domain; angenommene Automation-Ereignisse werden direkt in PostgreSQL gespeichert. Das eigene Connect muss diese Payloads nicht zwischenspeichern. T3 Connect kann bereits die bestehenden Webhooks puffern; die [bestehenden Grenzen](docs/user/project-settings.md#webhook-automations) bleiben relevant. Dessen optionale Durable-Object-Inbox wird für den ersten Fork-Betrieb nicht aktiviert und nicht als automatische Erweiterung für neue Automation-Routen vorausgesetzt.

Eigene Bot-Kommentare und PR-Updates müssen über Herkunfts-/Korrelationsdaten oder bewusst konfigurierte Filter von erneuten Triggern ausgeschlossen werden. Sonst baut die Automation eine Rückkopplungsschleife.

## 8. Workspaces, mehrere Repositories und Swarms

### 8.1 Drei getrennte Entscheidungen

**Platzierung** bestimmt die Maschine. **Isolation** bestimmt die Prozess-/Dateisystemgrenze. **Workspace-Lebensdauer** bestimmt, welche Steps dieselben Dateien benutzen. Diese Eigenschaften dürfen nicht in einem einzigen Feld `sandbox: true` verschwinden.

| Einstellung | Beispiel                                     | Konsequenz                                                    |
| ----------- | -------------------------------------------- | ------------------------------------------------------------- |
| Platzierung | Feste Linux-Maschine oder Pool `linux-build` | Keine automatische Verlagerung außerhalb dieser Auswahl       |
| Isolation   | Vertrauenswürdiger Host, Container oder VM   | Unterschiedliche Schutz- und Betriebsanforderungen            |
| Lebensdauer | Pro Run, pro Step oder pro Repository im Run | Unterschiedliche Übergabe-, Parallelitäts- und Cleanup-Regeln |

Eine Run-Sandbox kann mehrere sequenzielle Steps aufnehmen. Eine Step-Sandbox wird nach Ergebnissicherung beendet. Mehrere Steps können auf derselben Maschine trotzdem in voneinander getrennten Sandboxes laufen.

Gemeinsam genutzte Checkouts haben höchstens einen schreibenden Step gleichzeitig. Parallel arbeitende Implementer bekommen eigene Checkouts/Branches. Gemeinsame Caches dürfen keine gemeinsam beschreibbaren Arbeitsverzeichnisse oder Credentials werden.

### 8.2 Zehn Repositories

Der typische Ablauf ist ein explizites Fan-out/Fan-in:

1. Ein Ticket wird angenommen; eine konfigurierte Repository-Menge wird auf konkrete IDs und Basis-Commits aufgelöst.
2. Pro Repository analysiert ein Agent die Betroffenheit und liefert ein strukturiertes Ergebnis.
3. Ein Join wartet auf die festgelegte Erfolgsbedingung; ein optionaler Planungs-Step löst Abhängigkeiten zwischen Repositories auf.
4. Nur für betroffene Repositories starten Implementer, jeweils mit der Analyse und dem gemeinsamen Plan.
5. Tests und Reviews laufen je Ausgabe-Revision. Ein Integrations-Step prüft gegebenenfalls repoübergreifende Verträge.
6. Nach der konfigurierten Freigabe werden PRs veröffentlicht und am ursprünglichen Ticket verlinkt.

Fan-out braucht stabile Element-IDs, maximale Größe, Parallelitätslimit und eine definierte Fehlerpolitik: alle Ergebnisse erforderlich, partielle Ergebnisse zulässig oder bei erstem Fehler abbrechen. „Zehn Agenten“ bedeutet nicht automatisch zehn gleichzeitige Prozesse; Maschinenkapazität und Provider-Konto-Limits können die Ausführung staffeln.

Ein einzelner Agent darf mehrere Repositories bearbeiten, wenn sein Step diese ausdrücklich referenziert. Dafür wird ein Workspace-Bundle mit einem primären T3-Projekt und zusätzlichen Repository-Mounts benötigt. Das ist neue Funktionalität: der heutige projektbezogene Thread-Start löst nicht automatisch Mehrfach-Checkout, Diff und Checkpoint auf.

Jedes Repository erhält eigene Basis-/Ergebnis-Commits, Berechtigungen und PR-Referenzen. Multi-Repo-Checkpoints müssen über ein Ergebnismanifest zusammengesetzt werden. Git unterstützt dadurch noch keine atomare Änderung über mehrere Repositories; Veröffentlichungsreihenfolge, Teilfehler und Kompensation bleiben sichtbar.

### 8.3 Beispiel für die spätere Definition

Das folgende YAML ist ein **konzeptionelles Format**, noch keine existierende API. Namen in `${...}` stehen für validierte Referenzen der zukünftigen Ausdruckssprache.

```yaml
name: ticket-to-reviewed-changes
version: 1
inputSchema: ticket-with-repository-set-v1

execution:
  environment: build-machine-01
  isolation: container
  workspaceLifetime: per-repository-per-run
  maxParallel: 4

steps:
  - id: investigate
    type: agent
    forEach: "${input.repositories}"
    itemKey: repositoryId
    agent: investigator@3
    repository: "${item.repositoryId}"
    instructions: "Prüfe die Betroffenheit anhand des Tickets."
    outputSchema: repository-impact-v1

  - id: plan
    type: agent
    needs: [investigate]
    join: all-succeeded
    agent: planner@2
    inputs:
      impacts: "${steps.investigate.outputs}"
    outputSchema: cross-repository-plan-v1

  - id: implement
    type: agent
    needs: [plan]
    forEach: "${steps.plan.output.affectedRepositories}"
    itemKey: repositoryId
    agent: implementer@5
    repository: "${item.repositoryId}"
    inputs:
      plan: "${steps.plan.output}"
    outputSchema: repository-change-v1

  - id: verify
    type: script
    needs: [implement]
    forEach: "${steps.implement.outputs}"
    itemKey: repositoryId
    repository: "${item.repositoryId}"
    revision: "${item.revision}"
    commandRef: approved-repository-checks@1

  - id: approve
    type: approval
    needs: [verify]
    join: all-succeeded
    subject: "${steps.implement.outputs}"

  - id: publish
    type: connector-action
    needs: [approve]
    forEach: "${steps.implement.outputs}"
    itemKey: repositoryId
    action: source-control.open-pull-request
    input: "${item}"
```

`commandRef` wird pro Repository auf einen freigegebenen Befehl aufgelöst. Die Definition enthält weder Access Tokens noch frei evaluierbaren Backend-Code. Die tatsächlichen Commits und Hashes werden im Run-Snapshot gespeichert.

## 9. Identitäten und Berechtigungen

### 9.1 Vier Identitäten getrennt behandeln

1. **T3-Identität:** Wer darf den Workflow anlegen, starten, ändern, freigeben oder stoppen?
2. **Worker-Identität:** Welche Maschine darf welchen Dispatch entgegennehmen und welche Artefakte schreiben?
3. **Agent-Provider-Konto:** Welches Codex-/Claude-/andere Konto stellt Modelle und Nutzungskontingent bereit?
4. **Source-Control-/Ticket-Konto:** Welche Repositories, PRs und Tickets darf der Step lesen oder verändern?

Ein Agent mit mehreren Repositories bekommt die ausdrücklich erlaubte Vereinigungsmenge. Eine Workflow-Vorlage kann keine Rechte gewähren, die Betreiber, Zielumgebung oder Credential-Verbindung nicht besitzen. Berechtigungen werden beim tatsächlichen Zugriff erneut geprüft.

### 9.2 GitHub App

Dein früherer Ansatz passt gut: Der private Schlüssel der GitHub App bleibt beim Credential Broker. Für einen Step wird ein Installation Access Token mit expliziten `repository_ids` und `permissions` angefordert. GitHub unterstützt diese Einschränkungen innerhalb der Rechte der Installation. [GitHub: Installation Access Tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

Die Implementierung verwendet das zurückgegebene Ablaufdatum und erneuert vor Bedarf. Sie behandelt Tokens als undurchsichtige Werte, setzt keine feste Länge voraus und schreibt sie nicht in Clone-URLs, Logs, Prompts oder Git-Konfigurationen. Ausgabe erfolgt etwa über einen kurzlebigen Credential Helper oder kontrollierte Connector-Aktionen.

Für den Anfang sollten Agenten Änderungen lokal erstellen; ein Publish-Step erhält die Schreibrechte und führt Push/PR-Erstellung aus. Direkte Agent-Aktionen über GitHub-CLI oder MCP bleiben möglich, benötigen aber explizite Rechte und erschweren Wiederholung und wirksames Fencing.

Repository-Begrenzung bedeutet nicht automatisch Branch-Begrenzung. Branch-Regeln müssen durch die Codeplattform beziehungsweise einen kontrollierten Publish-Pfad durchgesetzt werden. Commit-Autor und authentifizierter Push-Actor sind ebenfalls unterschiedliche Dinge.

### 9.3 Azure DevOps und Jira

Für Azure DevOps Services sind Service Principals oder Managed Identities mit kurzlebigen Entra-Tokens ein geeigneter Ansatz. Die Identität braucht zusätzlich die erforderlichen Azure-DevOps-Zugriffe. Managed Identity passt zu Azure-gehosteten Workern; für andere Hosts kommen etwa föderierte Service Principals infrage. [Microsoft: Anwendungsidentitäten für Azure DevOps](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops)

Nicht annehmen, dass jeder Host das GitHub-Modell eines pro Step auf Repository-Rechte reduzierten Tokens bietet. Wo eine Identität breitere Rechte hat, müssen getrennte Identitäten oder ein autorisierender Broker die Grenze herstellen. Ein lokales Feld `allowedRepos` begrenzt einen bereits ausgegebenen breiteren Bearer-Token nicht.

Jira erhält eine separate Verbindung mit passenden Projekt-/Ticket-Rechten und einem zu Cloud beziehungsweise Data Center passenden Auth-Verfahren. Ein Ticket-Connector gehört nicht künstlich in die Source-Control-Provider-Abstraktion. Die konkrete JSM-App-/OAuth-Variante wird vor ihrer Umsetzung festgelegt.

### 9.4 Codex, Claude und Subscription-Nutzung

Für die erste Version bleiben Agent-Provider-Konten auf dem ausgewählten dauerhaften T3-Environment. Dadurch funktionieren die bestehenden Anmelde- und Nutzungsanzeigen weiter. Ein Agent-Profil referenziert eine logische Kontobindung; der Worker löst sie in eine dort autorisierte Provider-Instanz auf.

Codex dokumentiert ChatGPT-Anmeldung für Subscription-Zugriff sowie separate API-Key-Anmeldung. Headless-Anmeldung ist vorgesehen. Das belegt aber keine unbegrenzte Parallelität oder beliebige Weitergabe eines persönlichen Kontos an Sandbox-Pools. Auth-Verfahren, Kontingente und tatsächliche Berechtigungen müssen für das verwendete Konto geprüft werden. [OpenAI: Codex-Authentifizierung](https://learn.chatgpt.com/docs/auth)

OpenAI beschreibt außerdem einen app-server-Pfad mit für ChatGPT-Plan-Nutzung autorisiertem OAuth-Token und explizitem Token-Renewal. Ob dieser Pfad für die gewünschte Integration und Konten verfügbar ist, ist ein eigener Integrationscheck; er ersetzt nicht automatisch T3s vorhandene Anmeldung. [OpenAI: Codex app-server mit ChatGPT-Plan-Nutzung](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

Für kurzlebige Sandboxes wird pro Provider ein unterstützter Credential-Bootstrap benötigt: Auswahl des Kontos, minimale Credential-Auslieferung, Refresh-Owner, Ablauf, Widerruf und erneute Anmeldung. Mehrere Kopien eines erneuerbaren Login-Caches dürfen nicht unkoordiniert Credentials überschreiben. Ein vollständiges Benutzer-Home wird nicht als Sandbox-Image verteilt.

Für Claude, Cursor, Grok, OpenCode und Antigravity ist Headless-/Sandbox-Unterstützung jeweils zu verifizieren. Der Workflow-Editor zeigt Fähigkeiten und fehlende Voraussetzungen, statt gleiche Unterstützung zu behaupten. Provider-/Modellwechsel oder Wechsel auf kostenpflichtige API-Nutzung erfolgt nur nach konfigurierter Erlaubnis.

## 10. Agent-Instruktionen und Skills

Eine Agent-Version enthält Instruktionen, Provider-/Modellanforderungen, Tool-Fähigkeiten, Skill-Versionen und Output-Schema. Ein Step kann zusätzliche Instruktionen und ausdrücklich erlaubte Konfigurationsüberschreibungen liefern. Die resultierende Konfiguration wird vor Start als lesbarer Snapshot gespeichert.

Die Zusammenstellung unterscheidet Plattformregeln, Agent-Grundinstruktionen, Workflow-/Step-Auftrag, Repository-Instruktionen und externe Eingabedaten. Ihre Abbildung auf die jeweiligen Provider-Formate liegt im Adapter. Das System darf keine überall identische Prompt-Priorität behaupten; Berechtigungen werden außerhalb des Prompts durchgesetzt.

Ein Skill-Bundle enthält Manifest, `SKILL.md`, unterstützte Provider, erlaubte Ressourcen und gegebenenfalls ausführbare Dateien. Jede Veröffentlichung hat eine unveränderliche Version und einen Inhalts-Hash. Die Sandbox lädt nur die gepinnten Bundles und prüft diese vor Nutzung.

Das Materialisieren erfolgt in einem isolierten, providergeeigneten Konfigurationsbereich. Bestehende Repo-Instruktionen werden nicht überschrieben. Provider, die Skills nicht nativ laden, erhalten nur explizit unterstützte Übersetzungen; ein fehlender zwingender Skill blockiert die Ausführung. Skill-Code läuft mit denselben Grenzen wie anderer Code im Step.

Skill-Inhalte werden zentral verwaltet, doch benötigte Secrets separat und erst zur Laufzeit vergeben. Katalog-Updates verändern laufende Runs nicht. Eine neue Agent-/Skill-Version wird erst nach Veröffentlichung und Auswahl wirksam; Rollback bedeutet Auswahl einer älteren Version für zukünftige Runs.

## 11. Memory, Artefakte und historische Einsicht

Eine kurzlebige Sandbox benötigt nicht zwingend langfristiges „Agent Memory“, um korrekt zu funktionieren. Zuerst braucht sie **dauerhaften Ausführungszustand und explizite Übergaben**. Vier Speicherarten sollten getrennt bleiben:

| Speicherart          | Beispiele                                                                 | Lebensdauer                                       |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Ausführungszustand   | Step-Zustand, Attempt, Lease, genehmigte Revision                         | Dauerhaft für Wiederaufnahme und Audit            |
| Artefakte            | Analysen, Patches, Git-Bundles, Testberichte, Anhänge                     | Unveränderlich; definierte Aufbewahrung           |
| Langfristiges Wissen | Architekturentscheidungen, bekannte Fehlerbilder, Repository-Konventionen | Versioniert, mit Scope, Herkunft und Gültigkeit   |
| Cache                | Abhängigkeiten, Build-Cache, Suchindex                                    | Wegwerfbar; keine Quelle verbindlicher Ergebnisse |

MVP-Memory besteht aus Repository-/Workflow-bezogenen Markdown- oder JSON-Einträgen und einfacher Suche. Eine Vektordatenbank ist dafür nicht erforderlich. Ein Memory-Eintrag enthält Quelle, Autor/Run, Revision, Gültigkeitsbereich und gegebenenfalls Ablaufdatum.

Agenten schlagen neue Einträge vor. Veröffentlichung kann je Workflow automatisch oder nach Prüfung erfolgen; Änderungen werden nicht als unkontrolliertes Überschreiben einer globalen `memory.md` umgesetzt. Gleichzeitige Updates nutzen Versionsprüfung. Private Ticket-Inhalte werden nicht automatisch organisationsweites Wissen.

### Historie nach Sandbox-Löschung

Solange eine Sandbox lebt, ist ihr T3-Thread die Quelle der Ausführungshistorie. Die Main Node hält eine eindeutig als solche behandelte Archivkopie mit Herkunfts-ID und bestätigter Sequenznummer. Übertragung ist wiederholbar und lückenprüfbar; Reconnect setzt am Cursor fort. Anhänge und Artefakte bekommen eigene bestätigte Transfers.

Vor normalem Cleanup müssen das finale Thread-Archiv, erforderliche Checkpoints/Patches, Git-Objekte, Testergebnisse und ein Abschlussmanifest bestätigt sein. Ein lokaler Git-SHA allein reicht nicht: nach Sandbox-Löschung muss auch das referenzierte Objekt verfügbar sein, etwa über einen autorisierten Remote-Ref oder ein gespeichertes Git-Bundle.

Ein erzwungener Ressourcenverlust kann trotzdem die letzten noch nicht übertragenen Daten verlieren. Die UI kennzeichnet solche Archive als unvollständig und macht keine vollständige Wiederherstellbarkeit vor. Unvollständige erforderliche Ergebnisse verhindern einen erfolgreichen Step-Abschluss.

Nach Löschung öffnet „Step ansehen“ das unveränderliche Archiv. „Mit diesem Ergebnis weiterarbeiten“ erstellt einen neuen Thread/Workspace aus dem gesicherten Stand. Es gibt keinen scheinbar aktiven Terminalzugang in eine verschwundene Sandbox.

Die Zeitleiste kann aufgezeichnete Nachrichten, Tools, Änderungen und Entscheidungen zeigen. Sie rekonstruiert keine nicht protokollierten internen Modellgedanken und nicht jeden Dateisystemzustand zwischen zwei Checkpoints.

## 12. Oberfläche und alle Zugangswege

Der neue Bereich heißt zunächst **Automations** und ist sichtbar an die ausgewählte Owner-Umgebung gebunden. Er bietet Workflows, Runs, Agenten/Skills, Verbindungen und Ausführungsziele. Ein Formular mit geordneter Step-Liste und deklarativem Import/Export reicht für die erste Version.

Ein Run zeigt Trigger-Herkunft, Workflow-Version, Repository-Menge, Step-Zustände, Versuche, Maschinen, Wartegründe und Ergebnisse. Von jedem Agent-Step führt ein Link in den vorhandenen Thread oder dessen Archiv. Ausgabe-Revision und zugehörige Freigabe bleiben sichtbar.

Die Übersicht lädt nur Zusammenfassungen. Transkripte, Diffs und Tool-Ausgaben werden beim Öffnen eines Steps paginiert geladen. Live-Updates sind auf sichtbare Runs begrenzt; ein Run mit hundert Agenten darf keine hundert vollständigen Chatverläufe an jeden Client senden.

- **Web lokal/gehostet:** Das eigene Web-Deployment spricht die Main Node an; das eigene Connect liefert die übrigen autorisierten Umgebungen. Keine eingebauten localhost-Origins. Die offizielle gehostete T3-App wird für Fork-Funktionen nicht vorausgesetzt.
- **Desktop:** Zunächst Windows mit derselben React-Oberfläche; bevorzugt als Remote-Client zur Linux-Main-Node. Die vorhandene lokale Desktop-Umgebung bleibt optional. Die Automation läuft weiter, wenn das Fenster geschlossen wird und der Owner-Server weiterläuft.
- **Mobile:** In den ersten Etappen keine Änderungen und keine eigene Distribution. Später können Run-Ansicht, Thread-Zugriff und Kontrollaktionen über dieselben Services ergänzt werden; dies ist eine gesonderte Etappe nach Bedarf.
- **Settings, Projekt und Command Palette:** Bestehende Aufgaben bleiben erreichbar. Aktionen verwenden dieselben Services, Rechteprüfungen und Owner-Zuordnungen.
- **Agenten/MCP:** Dieselben Fähigkeiten über dünne Tools zugänglich machen. Verwaltung, Ausführung, Freigabe und Zugriff auf Credentials erhalten getrennte Berechtigungen.

Neue Client-Mutationen verwenden `createEnvironmentRpcCommand`; geschützte Methoden werden in `CLIENT_GUARDED_RPC_SCOPES` registriert. Alte Server ohne Automation-Capability zeigen keine funktionslosen Aktionen. Der Zielserver bleibt bei jeder Ausführung die letzte Autorisierungsinstanz.

## 13. Konkrete Integration ins Repository

### 13.1 Eigene Feature-Module und schmale Integrationsstellen

Die folgenden Pfade sind Vorschläge, keine schon vorhandenen Dateien. Der erste Aufbau bleibt im vorhandenen Monorepo und Serverprozess; eine allgemeine Plugin-Plattform oder ein zusätzlicher Backend-Dienst ist dafür nicht erforderlich.

| Ort                                                             | Geplante Änderung                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/automation/`                            | Eigene versionierte Workflow-/Run-/Step-/Artefakt-Schemas, RPC-Gruppe und Capability-Beschreibung                                          |
| `packages/contracts/src/rpc.ts` und Berechtigungsregistrierung  | Kleine Kompositionsänderung zur Einbindung der Automation-RPC-Gruppe und ihrer Rechte                                                      |
| `apps/server/src/automation/`                                   | Definitionen, reine Zustandsentscheidungen, persistenter Store und Ausführungs-Worker                                                      |
| `apps/server/src/automation/t3/`                                | Einziger Adapterbereich zu T3-Launch, Abschluss, Stop, Peer-Verbindungen, Trigger-Helfern, Source Control und Secret-Speicher              |
| Server-Bootstrap, HTTP-/RPC-/MCP-Registrierung                  | Automation-Layer und dünne Handler registrieren; eigene fachliche Logik bleibt im Feature-Modul                                            |
| `apps/server/src/orchestration-v2/`, `peer/`, `scheduledTasks/` | Nur erforderliche kleine Service-/Abschluss-Hooks; keine dort verteilte Workflow-Zustandsmaschine                                          |
| `apps/server/src/automation/sourceControl/`                     | Eigene kontrollierte Publish-Aktionen und Grants; bestehende Source-Control-Driver über Adapter weiterverwenden                            |
| `apps/server/src/automation/connectors/`                        | Ereignis-Normalisierung für GitHub, Azure DevOps und Jira; erst bei echtem Wiederverwendungsbedarf eigene Pakete                           |
| `apps/server/src/automation/credentials/`                       | Zeitlich und fachlich begrenzte Credential-Grants; bestehende Secret-Speicher über Adapter nutzen                                          |
| `apps/server/src/automation/sandboxes/`                         | Provisioning-Schnittstelle, erster Adapter, Supervisor und Cleanup                                                                         |
| `infra/relay/` und eigene Deployment-Komposition                | Eigene Connect-Instanz mit PostgreSQL auf der VPS, eigenen Domains, Auth- und Tunnel-Ressourcen; bestehende Relay-Services wiederverwenden |
| `packages/client-runtime/src/automation/`                       | Gemeinsame Commands, Berechtigungen, Run-State und inkrementelle Subscriptions                                                             |
| `apps/web/src/features/automation/`                             | Eigener Editor und Run-/Step-Ansichten; schmale Route und Navigationseinbindung                                                            |
| `apps/mobile/src/features/automation/` – nur spätere Option     | Keine Änderung im ersten Umfang; spätere Mobile-Ansichten können denselben Contract verwenden                                              |
| `apps/server/src/automation/persistence/`                       | Eigene PostgreSQL-Layer, Migrationshistorie und Tabellen für Automation; keine Automation-Migrationen in Upstreams Nummernfolge            |
| `evals/automation/`                                             | Eigene Fälle für neue Modellinstruktionen, Skill-Auflösung und Automation-MCP-Tools                                                        |

Die Workflow-Zustandsmaschine bleibt fachlich von der Turn-Zustandsmaschine getrennt. Sie übernimmt deren Prinzip „erst Intent committen, dann Effekt ausführen“. Es gibt keinen zweiten Codepfad, der Provider direkt neben `ThreadLaunchService` startet, und keine Agentensteuerung in HTTP-/WebSocket-Handlern.

Workflow-Ereignisse, Automation-Projektion, Automation-Command-Receipt und Automation-Outbox werden in derselben PostgreSQL-Transaktion in `fork_automation` geschrieben. Bestehende Thread-Events werden durch den T3-Adapter über einen gespeicherten Cursor beziehungsweise stabile Ergebnis-Commands konsumiert. So muss kein globaler Gesamt-Event-Stream aller Worker in den zentralen Thread-Orchestrator hineingezogen werden.

### 13.2 Abhängigkeitsrichtung und Integrationsvertrag

Die Workflow-Domäne kennt Aufträge, Attempts und Ergebnisse, aber weder T3s interne SQL-Tabellen noch konkrete Provider-Driver. Der Adapter übersetzt wenige Operationen wie `launchStep`, `readStepExecution`, `followStepExecution`, `cancelStep` und `exportStepArtifacts` auf vorhandene T3-Services. Das sind Entwurfsnamen für interne Ports, keine behaupteten existierenden APIs.

Die Abhängigkeiten laufen von Domain zu eigenen Port-Typen und von deren Implementierung zu T3. Ein Architekturcheck begrenzt direkte Imports aus `orchestration-v2`, `peer`, Provider- und Persistenzinternals auf den Adapterbereich. UI-Komponenten verwenden Automation-Contracts und den gemeinsamen Client-Runtime-Code. Bestehende Chat-, Diff- und Design-System-Komponenten werden wiederverwendet statt kopiert.

Die Zuordnung von StepAttempts zu T3-Threads liegt in eigenen Tabellen. Zusätzliche Daten werden nicht als neue Pflichtfelder in jede bestehende Thread-Projektion eingefügt. Wo ein echter T3-Hook nötig ist, wird dessen Zweck und Contract in einem eigenen kleinen Integrationscommit festgehalten. Ein Adapter macht interne T3-APIs nicht stabil; er begrenzt die Stellen, die bei Änderungen angepasst werden müssen.

RPC-Tags, Capability-Namen und lokale Speicherbezeichner erhalten einen eindeutigen Fork-Namespace. Ein späteres Upstream-Feature namens „Automations“ darf nicht zufällig dieselben Wire- oder Persistenznamen verwenden. Für eine umgesetzte Protokollversion gibt es einen expliziten Kompatibilitätsbereich; unbekannte Versionen werden verständlich abgelehnt. Keine unbegrenzte Kompatibilitätssammlung für alle jemals erschienenen T3-Versionen.

### 13.3 Eigene Migrationen und Datenlebensdauer

Upstream registriert seine Migrationen zentral in [Migrations.ts](apps/server/src/persistence/Migrations.ts); [databaseMigrationHead.ts](apps/server/src/persistence/databaseMigrationHead.ts) verwendet diese Historie auch zur Versionsprüfung. Eigene Migrationen einfach an die nächste freie Nummer anzuhängen oder sehr hohe Nummern zu reservieren, würde bei späteren Übernahmen Konflikte beziehungsweise falsche Versionsannahmen erzeugen.

Daher erhält `fork_automation` eine eigene PostgreSQL-Migrationsliste und Versionsprüfung. Die Implementierung nutzt eine eigene Effect-Pg-Layer; `@effect/sql-pg` ist im Relay bereits vorhanden. Das Relay behält für `fork_connect` seine eigene PostgreSQL-Migrationshistorie. T3s lokale `statev2.sqlite` und ihre Migrationen bleiben separat. Startup und Update-Preflight prüfen die jeweils benötigten Schema-Versionen getrennt. Bereits veröffentlichte Migrationen werden nicht nachträglich umnummeriert oder verändert.

Automation schreibt nicht direkt in T3-Tabellen und legt keine Cross-Database-Fremdschlüssel oder Trigger an. Thread-Löschung, Archivierung und Projektänderungen werden über Services/Ereignisse beziehungsweise Abgleich berücksichtigt. Ein gelöschter Thread erzeugt einen sichtbaren fehlenden Bezug; er darf nicht heimlich einen neuen Step starten.

Backups und Restore brauchen trotzdem einen abgestimmten Konsistenzpunkt: PostgreSQL wird mit datenbankgerechten Backups und WAL-Aufbewahrung gesichert; T3-Zustand und Artefakte erhalten zugeordnete Snapshots/Manifeste. Für den ersten koordinierten Restore-Punkt werden Trigger und Dispatch pausiert und laufende Finalisierungen abgearbeitet. Ein Zeitpunkt in PostgreSQL allein stellt entfernte Worker und externe PRs nicht auf denselben Zeitpunkt zurück. Nach Restore werden Leases, Worker-Zustand und externe Seiteneffekte vor Fortsetzung abgeglichen. Details stehen im Deployment-Plan.

### 13.4 Geplantes Vorgehen für Upstream-Updates

`origin` soll langfristig auf den Fork zeigen, `upstream` auf das originale T3-Repository. Dies ist eine geplante Arbeitsweise; die aktuelle Git-Konfiguration wird durch diesen Entwurf nicht geändert. Der veröffentlichte Fork behält eine kontinuierliche Historie. Regelmäßige Integrationsmerges übernehmen einen ausgewählten Upstream-Commit oder Release-Tag; die gemeinsam verwendete Fork-Historie wird nicht bei jedem Update umgeschrieben.

Eigene Features, notwendige T3-Integrationsänderungen und Branding/Release-Konfiguration bleiben in getrennten, verständlichen Commits. Keine großflächigen Umbenennungen, Formatierungen oder Dependency-Upgrades neben einem Feature. Kleine upstreamgeeignete Hooks können bei Bedarf unabhängig vorgeschlagen werden; das Produkt darf nicht von deren Annahme abhängen.

Ein Update folgt diesem Ablauf:

1. Ausgewählten Upstream-Stand auf einem Integrationsbranch in den Fork mergen. Der zuletzt erfolgreich integrierte Upstream-SHA ist Teil der Release-Metadaten.
2. Konflikte bearbeiten und Änderungen an Launch/Stop, Abschluss-/Checkpoint-Signalen, Auth, RPCs, Migrationen und gemeinsam verwendeten UI-Komponenten gezielt prüfen. Ein konfliktfreier Git-Merge belegt keine semantische Kompatibilität.
3. Adapter-Contract-Tests, Automation-Recovery-Tests und Datenbank-Upgrades auf isolierten Kopien ausführen. Besonders der Übergang von Zustellung zu tatsächlich abgeschlossenem Step bleibt abgesichert.
4. Einen integrierten Replay-Durchlauf von Trigger bis Ergebnis sowie die berührten Web-/Windows-Desktop-Pfade prüfen. Eine Mobile-Abnahme folgt erst mit einer eigenen Mobile-Etappe. Direkte und entfernte Verbindungen nach betroffenen Änderungen einbeziehen.
5. Einen eigenen Vorab-Build bereitstellen; erst nach Prüfung den Fork-Release freigeben. Ausstehende Upstream-Sicherheitskorrekturen können gezielt vorgezogen werden und werden beim nächsten Merge abgeglichen.

Tests laufen gemäß Repository-Regeln gezielt; umfangreichere Release-Matrizen gehören in CI. Anfangs reichen gezielte Checks für Linux-Server, gemeinsamen Web-Code, Windows-Desktop und einen Client/Server ohne Automation-Capability. Eine Prüfung älterer Worker-Protokollstände kommt hinzu, sobald tatsächlich mehrere Versionen unterstützt werden. Ein gewöhnlicher Upstream-Server bleibt für normale T3-Funktionen nutzbar; als Automation-Worker gilt er nur bei tatsächlich vorhandenen und geprüften Fähigkeiten.

Bei größeren Upstream-Änderungen wird zuerst der Adapter angepasst. Ein neues eigenes Package oder ein separater Dienst wird erst eingeführt, wenn eine konkrete gemeinsame Nutzung oder unabhängige Deployment-Anforderung das rechtfertigt. Die Strategie reduziert Konflikte, verspricht aber keine wartungsfreien Updates.

### 13.5 Eigene Distribution und Update-Kanäle

Der erste Fork-Betrieb benötigt eigene Produktwerte für Linux-Container, Windows-Desktop-App-ID, Deep Links und Datenverzeichnisse. Eigene CLI-Paketveröffentlichung, Mobile-Bundle-IDs, weitere Desktop-Plattformen und deren Release-Kanäle folgen erst bei tatsächlichem Bedarf. Die Quellstruktur wird dafür nicht pauschal umbenannt; forkbezogene Build-/Release-Werte werden soweit möglich an wenigen Stellen konfiguriert. Die normale T3-Installation und der Fork sollen parallel betreibbar bleiben.

Desktop-Updater, CLI-/Server-Self-Update und Remote-Update werden für eigene Builds zunächst deaktiviert beziehungsweise auf manuelle Fork-Updates begrenzt. Automatische Updates werden erst mit einem eigenen geprüften Release-Kanal aktiviert. Ein Fork-Client darf weder sich selbst noch einen Fork-Worker versehentlich durch ein offizielles T3-Artefakt ersetzen. Release-Metadaten enthalten Fork-Version, Upstream-Basis-SHA, Automation-/Connect-Protokollversionen und die Schema-Versionen für Automation, Relay und T3-Zustand. Rollback ist nur auf mit dem Datenbestand kompatible Builds oder über einen koordinierten Restore zulässig.

Web-Frontend und Backend des Forks werden über eigene Deployments bereitgestellt; `app.t3.codes` enthält die zusätzlichen Ansichten nicht. Ebenso enthalten die offiziellen mobilen Apps nicht automatisch die Automation-Oberfläche. Für neue mobile Funktionen wären eigene Builds und deren Distribution erforderlich; beides gehört ausdrücklich nicht zum anfänglichen Umfang. Die eigene Connect-Instanz verwendet eigene Clerk-, Cloudflare- und PostgreSQL-Ressourcen. Der offizielle T3-Connect-Dienst ist keine Betriebsabhängigkeit; die Wiederverwendung seines Codes und die verbleibenden Anbieterabhängigkeiten sind im Deployment-Plan ausgewiesen.

### 13.6 Zusätzliche Abnahmekriterien für jede Etappe

- Neue fachliche Logik liegt im Automation-Bereich; Änderungen außerhalb davon sind einzeln begründet.
- Persistenz, RPCs und Feature-Aktivierung bleiben voneinander unterscheidbar. Deaktivierte Automation startet keine Trigger oder Worker und belastet den normalen Chatpfad nicht mit zusätzlichen Subscriptions.
- Die Adaptergrenze hat Verhaltenstests für die tatsächlich verwendeten T3-Operationen; ein internes Refactoring darf nicht unbemerkt andere Abschluss- oder Abbruchsemantik erzeugen.
- Ein neuer Upstream-Stand wird in einem isolierten Checkout probeweise integriert, sobald ein geeigneter neuer Stand vorliegt; Konflikte und nötige Anpassungen werden am Integrations-PR festgehalten.
- Bestehende T3-Funktionen und historische Daten bleiben über ihren bisherigen Pfad verfügbar. Eine spätere inhaltliche Überschneidung mit Upstream wird bewusst migriert, nicht durch automatische Zusammenlegung gleichnamiger Features behandelt.

## 14. Umsetzung in überprüfbaren Etappen

### Etappe 0 – Grenzen bestätigen und technische Risiken prüfen

Festgelegt sind dauerhafter Fork, VPS-Main-Node, Cloudflare-Domain und PostgreSQL. Vor der Workflow-Implementierung wird der vertikale Infrastruktur-Durchstich aus [FORK_DEPLOYMENT.md](FORK_DEPLOYMENT.md) umgesetzt: eigenes Web/Connect, Main Node und ein registriertes Linux-Ausführungsziel erscheinen nach Anmeldung in Web und Windows-Desktop. Main Node und Ausführungsziel dürfen zunächst auf derselben VPS betrieben werden. Zu entscheiden bleiben erster produktiver Workflow, erster Provider/Connector, Vertrauensmodell und Publish-Freigabe. Kleine technische Prüfungen klären Run-Abschluss plus Checkpoint, Remote-Launch ohne Eltern-Agenten und unterstützte Provider-Anmeldung im vorgesehenen Ausführungsmodus.

**Abnahme:** Für einen Step sind Zustellung, Agentenabschluss und gesichertes Ergebnis getrennt nachweisbar. Authentifizierung wird auf dem vorgesehenen Host tatsächlich unterstützt. Kein Infrastrukturkauf oder größerer Umbau vor dieser Klärung.

### Etappe 1 – Vertikaler MVP auf einer dauerhaften Maschine

Versionierte Definitionen, Inline-Agent-Konfiguration, manuelle Starts, eigener Automation-Trigger-Eingang mit wiederverwendeter Schedule-/Webhook-Logik, sequenzielle Agent-/Test-/Freigabe-Steps und ein Worktree auf einem festen Ausführungsziel. Dazu eigene PostgreSQL-Automation-Persistenz, T3-Adapter, Restart-Recovery, idempotenter Start, Abbruch und einfache Run-Ansicht mit Thread-Links. GitHub-Publishing läuft kontrolliert mit begrenztem Zugriff; Agenten erhalten zunächst keine allgemeinen Publish-Credentials.

Web und Windows-Desktop erhalten den einfachen Editor und die Run-Steuerung. Mobile bleibt unverändert. Ein Repository pro Run und ein Linux-Ausführungsziel; noch kein Sandbox-Pool oder Windows-Worker-Port.

**Abnahme:** Ein ausgewähltes GitHub-Issue läuft bis zum geprüften PR. Doppelzustellung und Main-Node-Neustart erzeugen keine zusätzlichen Threads für denselben Attempt und keinen doppelten PR. Fehlgeschlagene Tests blockieren Publishing. Eigene Migrationshistorie, Adapter-Contract-Tests und Fork-Release-Konfiguration sind bereits Bestandteil dieses MVP.

### Etappe 2 – Wiederverwendung und mehrere Repositories

Agent-Katalog, gepinnte Skills, strukturierte Output-Übergaben, Fan-out/Join, fixe Grenzen und Repository-bezogene Workspace-Zuordnung. Zunächst ein Agent pro Repository; mehrere Repositories in einem Agent-Step folgen nach Erweiterung von Workspace-Bundle, Diff und Checkpoint. Begrenzte Reparaturschleifen werden explizit modelliert.

**Abnahme:** Zehn Repository-Analysen werden mit konfigurierter Parallelität verarbeitet; nur betroffene Repositories gehen in Implementierung. Teilfehler und Join-Regeln sind sichtbar und reproduzierbar. Keine zwei Writer teilen unbeabsichtigt einen Checkout.

### Etappe 3 – Mehrere dauerhafte Worker und gezielte Verteilung

Der feste Remote-Worker einschließlich idempotentem Dispatch, Leases, Resume und Cancel gehört durch den VPS-Betrieb bereits zum Infrastruktur-Durchstich und MVP. Diese Etappe erweitert ihn um mehrere Ziele, Kapazitätsverwaltung und ausdrücklich definierte Verteilungsregeln. Provider-Konten verbleiben pro Worker. Feste Maschinenwahl bleibt verfügbar; ein Ausfall erlaubt keinen unkonfigurierten Wechsel auf eine andere Maschine.

**Abnahme:** Ein Run kann freigegebene Steps auf mehrere geeignete Maschinen verteilen und deren Kapazitätsgrenzen einhalten. Browser-Schließen, Verbindungsabbruch und Neustart des Koordinators verlieren den Run nicht. Ein unklarer Remote-Status löst keine konkurrierende Implementierung aus.

### Etappe 4 – Echte kurzlebige Sandboxes

Ein Sandbox-Backend, reproduzierbare Images, Credential-Bootstrap, Skill-Materialisierung, kontinuierliches Archiv, Artefakttransfer, TTL und Garbage Collection. Run- und Step-Lebensdauer werden getrennt unterstützt. Cleanup läuft unabhängig von einem noch verbundenen Client.

**Abnahme:** Nach Sandbox-Löschung sind Step-Historie, geprüfte Änderungen und benötigte Git-Objekte abrufbar. Eine neue Sandbox kann daraus weiterarbeiten. Erzwungener Verlust wird als unvollständig ausgewiesen. Alte Leases oder Credentials erlauben keine neue kontrollierte Veröffentlichung.

### Etappe 5 – Weitere Connectoren und dauerhaftes Wissen

Azure-DevOps- und Jira-/JSM-Connectoren, Polling-Reconciliation, Memory-Katalog mit Herkunft und Aufbewahrung, differenziertere Rollen. Mobile ist eine unabhängige spätere Option und keine Voraussetzung für diese Etappe. Reihenfolge nach tatsächlichem Bedarf; wenn Azure DevOps zuerst benötigt wird, ersetzt es GitHub im MVP statt einen zweiten MVP zu erzeugen.

**Abnahme:** Externe Tickets können zuverlässig auf dieselben Workflows abgebildet werden. Doppelte/verspätete Events, abgelaufene Anmeldungen und Memory-Konflikte bleiben kontrollierbar.

### Etappe 6 – Nur bei belegtem Bedarf skalieren

Worker-Pools, zusätzliche Sandbox-Backends, größere Artefaktspeicher und gegebenenfalls hochverfügbare Steuerung. Vor Erweiterungen der PostgreSQL-Topologie oder einem Broker-/Workflow-Engine-Wechsel werden Queue-Latenzen, Ereignisrate, Speicherwachstum und Betriebsaufwand gemessen. Eine alternative Workflow-Engine übernimmt dann bewusst die Workflow-Ausführung; sie läuft nicht zusätzlich als konkurrierende Wahrheit daneben.

## 15. Tests und Betrieb

Die wichtigsten Tests prüfen Ausfallgrenzen, nicht gerenderte Texte:

- Webhook akzeptiert, Prozess stirbt vor Dispatch: genau ein zugeordneter Run nach Wiederaufnahme.
- Dispatch angenommen, Antwort verloren: dieselbe Thread-Referenz bei Wiederholung.
- Agent beendet, Checkpoint oder Artefakttransfer noch offen: Step bleibt in Finalisierung.
- Worker offline, Lease abgelaufen, altes Ergebnis kommt später: keine Überschreibung und kein unkontrollierter Doppel-Writer.
- PR erstellt, Antwort verloren: Reconciliation findet den vorhandenen PR.
- Abbruch während Provisioning oder Credential-Ausgabe: keine vergessene Sandbox und keine nachträgliche Veröffentlichung.
- Fan-out mit Teilfehlern und Retry: Join berücksichtigt die richtigen Attempts und unveränderte Element-IDs.
- Ablauf/Widerruf von Credentials, begrenzte Repository-Rechte und verweigerte Remote-Aktionen.
- Schedule-Zeitzonen, DST, verpasste Termine, Workflow-Updates und doppelte Bot-Ereignisse.
- Skill-Version verändert, Run bereits gestartet: unverändertes gepinntes Bundle.
- Archiv lückenhaft oder Git-Objekt fehlt: kein fälschlich vollständiger Abschluss.

Tests erweitern möglichst die vorhandenen Service-Tests auf der niedrigsten passenden Ebene. Effect-Tests verwenden `TestClock`, `Deferred`, Queues oder drainbare Worker; keine Sleeps als Erfolgsbedingung. Provider-/Worker-/Connector-Fakes erlauben deterministische Fehlerfälle. Für den integrierten UI-Durchlauf wird der Replay-Provider verwendet; echte kostenpflichtige Turns nur bei providerabhängigen Fragestellungen.

Vor Änderungen an modellseitigen Instruktionen oder MCP-Beschreibungen gilt `evals/README.md`. Gezielte Checks begleiten die Etappen; vor einem späteren Push `vp run check:changed`, keine ungefragten repo-weiten Testläufe.

Betrieblich braucht es Metriken für wartende Runs, Queue-Alter, laufende Steps, verlorene Worker, Retry-Ursachen, Auth-Probleme, Archiv-Rückstand und Sandbox-Ressourcen. Provider-Nutzung wird nach Konto und Run aggregiert; fehlende Preis-/Tokeninformationen werden als unbekannt statt als null angezeigt. Laufzeit-, Parallelitäts- und Iterationsgrenzen sind früh umsetzbar; präzise Kostenlimits hängen von der verfügbaren Provider-Telemetrie ab.

Backups umfassen PostgreSQL mit Automation- und Connect-Datenbanken, erforderliche lokale T3-Datenbanken, Blob-Speicher und gesondert gesicherte Secret-Schlüssel; der Konsistenzpunkt folgt Abschnitt 13.3 und dem Deployment-Plan. Restore wird mit pausierten Triggern und gesperrtem Publishing gestartet, bis externe Aktionen abgeglichen sind. Aufbewahrung und Löschung erfassen auch Anhänge, Memory, Sandbox-Snapshots und Archive. Ein Garbage Collector entfernt verwaiste Ressourcen anhand des gespeicherten Besitzers und Zustands.

## 16. Entscheidungen für die nächste Iteration

Festgelegt sind der dauerhafte Fork mit regelmäßiger Upstream-Integration, die VPS als Main Node, die eigene Cloudflare-Domain, PostgreSQL ab Version eins und der zentrale Connect-Einstieg. Für den Start werden die Betriebsdetails unter Punkt 2 sowie die fachlichen Entscheidungen unter 1, 3, 4 und 5 benötigt; weitere Punkte folgen vor der jeweiligen Etappe.

1. **Erster konkreter Ablauf:** GitHub-Issue → PR, Azure-Work-Item → PR oder JSM-Ticket → Analyse? Empfehlung: genau ein Ablauf durchgehend.
2. **Betriebsdetails:** Tatsächliche Domain, Linux-Distribution/CPU-Architektur/Ressourcen der VPS, verfügbares Cloudflare-Konto, eigene Clerk-Instanz und Backup-Ziel. Linux als Serverplattform und Windows als erster Desktop-Client sind festgelegt. VPS, PostgreSQL und zentraler Client-Einstieg sind bereits festgelegt; die vorgeschlagenen Hostnamen im Deployment-Plan sind Platzhalter.
3. **Erster Agent-Provider und Konto:** Welche vorhandene Subscription soll eingesetzt werden? Darf bei Bedarf ausdrücklich auf API-Abrechnung gewechselt werden? Standard: kein automatischer Wechsel.
4. **Vertrauensmodell:** Nur eigene Repositories und Team-Inputs oder auch öffentliche/fremde Beiträge? Empfehlung: MVP auf vertrauenswürdigem Worker mit explizitem Trigger-Opt-in; fremde Codeausführung erst mit passender Isolation.
5. **Veröffentlichung:** Nur lokale Änderungen, Draft-PR automatisch oder Freigabe vor Push/PR? Empfehlung: kontrollierter Publish-Step mit Freigabe im ersten Durchstich.
6. **Workspace-Standard:** Gemeinsamer Run-Workspace, pro Step oder pro Repository? Empfehlung: pro Repository im Run, Schreibzugriffe sequenziell.
7. **Sandbox-Infrastruktur:** Welcher erste Container-/VM-Host ist tatsächlich vorhanden? Das entscheidet den ersten Adapter.
8. **Parallelität und Fehlerpolitik:** Wie viele gleichzeitige Agenten pro Maschine und Konto; müssen alle Repositories erfolgreich sein?
9. **Memory:** Welches Wissen soll wirklich wiederverwendet werden, in welchem Scope und mit welcher Freigabe?
10. **Aufbewahrung:** Wie lange bleiben vollständige Transkripte, Ticket-Payloads, Git-Artefakte und Sandbox-Snapshots gespeichert?
11. **Team-Berechtigungen:** Wer darf Definitionen veröffentlichen, produktive Credentials zuordnen und konkrete Änderungen freigeben?
12. **Authoring:** Formular plus YAML/JSON ausreichend oder später graphischer Editor? Empfehlung: mit Formular und versionierbarem Export beginnen.
13. **Verfügbarkeit:** Reicht Neustart-Recovery auf einer Main Node oder wird echte Hochverfügbarkeit benötigt?
14. **Fork-Release-Strategie:** Wie soll das Produkt heißen, wo werden eigene Builds veröffentlicht und in welchem Rhythmus werden Upstream-Stände integriert? Empfehlung: regelmäßige kleine Integrationsmerges und dokumentierter Upstream-SHA pro Build; zunächst manuell bereitgestelltes Linux-Image und Windows-Build, später eigene automatische Release-Kanäle.

Der nächste Umsetzungsschritt wäre Etappe 0 mit einem ausgewählten End-to-End-Ablauf. Die hier beschriebenen Entities und Grenzen können dabei stabil bleiben, während Details wie erster Connector, Sandbox-Host und Memory-Form anhand deines tatsächlichen Betriebsmodells geschärft werden.
