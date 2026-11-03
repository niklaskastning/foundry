# Isolierter Foundry-Host-Worker

Der Installer verwaltet ausschließlich die vier `foundry-host`-/`foundry-connector`-System-Units. Er erstellt weder Benutzer noch Provider-Anmeldungen, lädt keine Releases herunter und startet keinen Dienst. Main und persönliche T3-Dienste bleiben getrennt. Voraussetzung für die Aktivierung bleibt die G2-Abnahme; Entwicklung des Installers ersetzt sie nicht.

## Vorbereitung

Auf einer freigegebenen Linux-Maschine legt ein Administrator Konto und Gruppe `foundry-worker` an: eigenes Home `/var/lib/foundry-worker/home`, nicht interaktive Shell (`nologin` oder `/bin/false`). Kein vorhandenes Benutzerkonto verwenden. Benötigt werden Node in der vom Repository vorgegebenen Version, Git und die T3-Laufzeitabhängigkeiten. Node muss über einen absoluten Pfad unter `/usr` oder `/opt` erreichbar sein. NVM unter einem persönlichen Home ist absichtlich ausgeschlossen. Der Dienst lädt keine Shell-Startdateien; sein PATH ist `/opt/foundry-worker/providers/bin:/usr/local/bin:/usr/bin:/bin`. Provider-Anmeldung/Bereitschaft folgt separat.

Aus einem sauberen, gepinnten Checkout `vp run foundry:build server` ausführen. Der Build schreibt `apps/server/dist/foundry-build.json` mit Fork, Commit und Dirty-Status. Wie beim bestehenden Foundry-Container das Produktionspaket erzeugen:

```sh
pnpm --config.allow-unused-patches=true --filter t3 deploy --prod --legacy /path/to/output
```

Das vollständige Paket einschließlich `dist`, Metadaten und produktiven Dependencies administrativ unter `/opt/foundry-worker/releases/<vollständiger-commit>/` ablegen. Release und Runtime bleiben root-eigen und für das Dienstkonto unveränderlich; keine Symlinks aus dem Paket in persönliche Checkouts. Der Installer akzeptiert passende Metadaten eines sauberen Foundry-Builds. Diese sind ein Herkunftshinweis, keine kryptographische Signatur; sichere Bereitstellung bleibt Betreiberaufgabe.

Eine Konfigurationsdatei enthält die folgenden Pflichtfelder; `providerInstanceId` und `artifactPublication` sind optional. Zahlen sind Beispielwerte, kein festgelegtes Produktionsbudget:

```json
{
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "node": "/opt/node/bin/node",
  "origin": "https://main.example.com",
  "port": 3973,
  "workspaceRoots": ["/srv/foundry-worker/workspaces/projects"],
  "cpuQuotaPercent": 100,
  "memoryMaxMiB": 2048,
  "tasksMax": 256,
  "accessFile": false
}
```

Backend und Connector teilen das CPU-/Speicher-/Task-Budget einer systemd-Slice einschließlich Kindprozessen. Workspace-Wurzeln sind private direkte Unterverzeichnisse von `/srv/foundry-worker/workspaces`. Schreiben ist dort, im eigenen Zustand und in privaten temporären Verzeichnissen möglich. Persönliche Homes sind verborgen, sonstige Systemdateien grundsätzlich schreibgeschützt. Das ist keine Sandbox für feindlichen Code und keine Garantie gegen fremde Writer oder alle lesbaren Host-Dateien. Siehe [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) und [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html). Disk-Quota und Provider-Parallelität sind dadurch nicht implementiert.

## Installieren und registrieren

Der Administrator installiert mit der geprüften Konfiguration:

```sh
python3 deploy/fork/worker/foundry-worker.py install --config /path/to/worker.json
systemctl daemon-reload
systemctl start foundry-host.target
```

Das Backend bindet ausschließlich Loopback und behält T3-Authentifizierung. Ohne Registrierung/Schlüssel überspringt systemd den Connector. Alle T3-Aufrufe dieses Workers verwenden ausdrücklich `--base-dir /var/lib/foundry-worker/t3`. Dort erzeugt das Backend eine eigene Environment-ID; niemals Daten aus `~/.t3/userdata` kopieren.

Nach dem ersten lokalen Start den vorhandenen [CLI-Enrollment-Weg](../../../docs/foundry/operations.md#experimental-device-enrollment-p06) unter dem Dienstkonto verwenden. Device-Schlüssel als `/var/lib/foundry-worker/device-key.json`, bestätigte Registrierung als `/var/lib/foundry-worker/registration.json` speichern, jeweils Eigentümer Dienstkonto und Modus `0600`. Bei vorgeschaltetem Access die separate Machine-Berechtigung als `/var/lib/foundry-worker/access.json` im vorhandenen Connector-Format (`origin`, `clientId`, `clientSecret`) provisionieren und `accessFile` aktivieren. Keine Secrets in Units, Befehlsargumenten oder Shell-History; Enrollment-Freigaben nach Verwendung entfernen. Der Installer ändert keine Cloudflare-Policy.

Dann `systemctl start foundry-connector.service` ausführen. Der Connector prüft Environment-ID und festen Loopback-Port. Status: `systemctl status foundry-host.service foundry-connector.service`; Logs: `journalctl -u foundry-host.service -u foundry-connector.service`. Logs können Pairing-Ausgaben enthalten und sind nicht ungeprüft zu veröffentlichen. Erst nach erfolgreicher Prüfung mit `systemctl enable foundry-host.target` für den Boot aktivieren. Kein Codex wird installiert oder gestartet.

## Zentrale Artefakte (P38a, noch keine Live-Abnahme)

`artifactPublication: true` setzt im Host die Bindungsdatei
`/var/lib/foundry-worker/artifact-binding.json`. Ohne diese Option bleibt der
persönliche/lokale T3-Pfad unverändert. Die Datei gehört ausschließlich zum
dedizierten Worker, Modus `0600`, mit den vorhandenen Device-/Machine-Dateien:

```json
{
  "origin": "https://main.example.com",
  "registrationFile": "/var/lib/foundry-worker/registration.json",
  "keyFile": "/var/lib/foundry-worker/device-key.json",
  "accessFile": "/var/lib/foundry-worker/access.json"
}
```

`accessFile` entfällt nur bei einem Main ohne vorgeschalteten Machine-Zugang.
Die Laufzeit prüft HTTPS-Origin und die lokale Environment-ID gegen die
Registrierung; sie kopiert keine Providerprofile und verändert keine Schlüssel.
Main benötigt Schema 6 und sein ausdrücklich aktiviertes P38a-Transferprofil.
Der Host verwendet signierte POSTs auf dem bestehenden Maschinenkanalpfad;
keine neue Cloudflare-Pfadfreigabe ist erforderlich.

Pending-Anhänge werden vor dem Nachrichten-Commit zentral veröffentlicht. Die
ursprüngliche Pending-ID hält Wiederholungen auch bei neuer lokaler Claim-ID
zusammen. Der Thread-Service prüft auch direkte Starts, Nachrichten,
Queue-Änderungen und Antworten mit Anhängen; bei fehlender Bestätigung beginnt
kein neuer Message-Commit. Bereits gespeicherte Receipts werden wiedergegeben.
Fehlgeschlagene Claims behalten ihre Pending-Quelle und entfernen lokale Kopien.
Downloads sind begrenzt und prüfen Chunk-/Gesamthash, auch bei leeren Dateien.
Die Device-Bindung erlaubt hier ausschließlich eigene Thread-Artefakte; sie ist
keine allgemeine Lesefreigabe für andere Devices oder ein Workflow-Dispatch.

Die isolierten PostgreSQL-/HTTP-/Dateiproben sind kein Ersatz für den noch offenen
Client- und Live-Gatenachweis. Koordinierte Aktivierungs-/Recovery-Helfer folgen
vor dem externen Aktivierungsauftrag; die laufende Installation bleibt unverändert.

## Stop, Neustart, Upgrade und Entfernung

`systemctl stop foundry-host.target` stoppt beide Dienste samt Kindprozessen; `systemctl restart foundry-host.target` startet sie mit demselben Home neu. Stop kann aktive Turns unterbrechen. Keine Prozessnamen-Muster zum Töten verwenden.

Vor Upgrade Arbeit beenden, Worker-Zustand samt Schlüsseln sichern, Target deaktivieren/stoppen und die unbenutzte Slice mit `systemctl stop foundry-host.slice` stoppen. Neuen kompatiblen Release bereitstellen, `revision` beziehungsweise Ressourcenbudget/Node-Pfad ändern, `install` wiederholen und `daemon-reload` ausführen. Origin, Port und Workspace-Wurzeln bleiben unverändert; Instanzwechsel ist kein Update. Identität, SQLite, Provider-Konfiguration und Enrollment bleiben erhalten. Erst nach Start und Prüfung wieder aktivieren. Kein automatischer Build-Downgrade nach Datenmigration; Recovery benötigt zusammenpassende Backup-/Build-Stände.

Bei gewöhnlichem Schreibfehler stellt der Installer alte Unit-Inhalte wieder her. Bei Stromverlust oder Prozessabbruch während Installation den Dienst deaktiviert lassen und Units sowie `installation.json` mit der gesicherten Konfiguration abgleichen, bevor neu geladen/gestartet wird. Abweichende oder fremde Units werden nicht stillschweigend überschrieben.

Entfernung: zuerst `systemctl disable --now foundry-host.target`, Slice stoppen, `python3 deploy/fork/worker/foundry-worker.py remove`, anschließend `systemctl daemon-reload`. Zustand, Workspaces, Schlüssel und Releases bleiben erhalten. Löschen sowie serverseitiger Device-/Access-Widerruf sind gesonderte Betreiberaktionen; Stop/Uninstall behauptet keinen Remote-Widerruf.

## Isolierte Prüfung

`--root /absoluter/temporärer/pfad` verlegt verwaltete Dateien in einen Offline-Dateibaum. Dort wird kein systemd angesprochen; Release-Fixtures müssen unter demselben Root liegen. Tests prüfen echte Dateisystemänderungen, Daten-/Identitätserhalt, Updatefehler, Pfadgrenzen und Unit-Syntax mit `systemd-analyze verify`:

```sh
python3 -m unittest discover -s deploy/fork/worker -p 'test_*.py' -v
```

Dies ersetzt **nicht** Start/Neustart, Ressourcenbegrenzung und Erreichbarkeitsprüfung unter dem echten Dienstkonto. Offene G1/G2/P13-Nachweise stehen im [Umsetzungsplan](../../../docs/foundry/implementation-plan.md#erledigte-implementierung-und-verbleibende-abnahmen); Issue #13 bleibt Nachweisarchiv.

## G3-Bestandsaufnahme vor der Provider-Einrichtung

Aus dem geprüften Checkout kann der Administrator ausschließlich lesend prüfen:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/inspect-g3.py
sudo /usr/bin/python3 -I deploy/fork/updater/activate-access.py status
```

Der Worker-Prüfer gleicht Installer-Manifest und Units ab, prüft private Datenwurzeln,
Release-Metadaten, tatsächliche Prozess-UID/cgroup und aktive gemeinsame Kernel-Limits.
Er startet nur `--version` des installierten T3-Einstiegs als `foundry-worker` mit dessen
Home und Arbeitsverzeichnis. Er liest keine Credentials, startet keinen Provider und
ändert oder stoppt keine Dienste. Abweichungen liefern einen Fehler ohne private
Unterprozessausgaben. `--root /offline/fixture` prüft nur Dateien, ohne Prozesse oder
Netzwerk. Das ist keine Lastprüfung und kein positiver Provider-/G3-Nachweis;
`providerReady` bleibt unbekannt. Den gebundenen Provider anschließend über
`foundry.workerStatus` frisch prüfen, etwa mit **Check selected worker**.

Für eine noch leere Bindung zuerst die folgende dedizierte Anmeldung abschließen;
keine vorhandenen Replay-Projekte oder persönlichen Checkouts für den G3-Auftrag
verwenden. Danach innerhalb einer bereits erlaubten Wurzel ein eigenes neues
Git-Repository mit initialem Commit anlegen. Command-ID und unveränderte Anfrage
vor dem ersten Worker-Launch privat speichern. Die konkrete Modell-/Turn-Freigabe
folgt erst nach bestätigter Provider-Bereitschaft; Anmeldung und `--version` sind
keine kostenpflichtigen Turns. Aktuelle Restabnahmen besitzt der
[Umsetzungsplan](../../../docs/foundry/implementation-plan.md#erledigte-implementierung-und-verbleibende-abnahmen).

## Codex im Worker einrichten und prüfen

Der Betreiber richtet Codex über die vorhandenen Provider-Einstellungen **dieses Workers** ein: lokalen Worker-Zugriff über einen geschützten Tunnel herstellen, mit einer eigenen lokalen T3-Session koppeln und unter Settings → Providers installieren/anmelden. Diese Session benötigt die normalen Provider-Verwaltungsrechte; der Main-Gateway-Zugang reicht dafür nicht aus. Alle Konfiguration und Anmeldung gehören zum Dienstkonto `foundry-worker` und dessen Home, niemals zum persönlichen T3-Profil. Keine bestehenden Credentials kopieren, keine API-Abrechnung automatisch aktivieren. Eine Installation oder Anmeldung startet noch keinen Agent-Turn.

Die dort gewählte Codex-Instanz-ID als optionales `providerInstanceId` in die Installer-Konfiguration aufnehmen, beispielsweise `"providerInstanceId": "codex"` für die tatsächlich vorhandene Standardinstanz. Dienst stoppen und das oben beschriebene Update-Verfahren ausführen. Der Installer erhält die explizite Bindung im Manifest und den Units über Neustarts und Updates; er wählt bei gelöschter/deaktivierter Instanz keinen Ersatz. Ohne dieses Feld bleibt der Worker ausdrücklich ungebunden. Provider-Konfiguration und Credential-Speicherung verwenden die bestehenden T3-Dienste im Worker-State.

Nach Auswahl des Devices in Connections prüft **Check selected worker** über dessen bestehende RPC-Verbindung die gebundene Instanz neu. Online, Provider-Bereitschaft und Kapazität sind getrennt. Fehlendes Binary, fehlende/unklare Anmeldung und unbekannte oder inkompatible Versionen ergeben keine Bereitschaft. Bei einem fehlgeschlagenen Probe darf ein älterer Registry-Cache keinen erfolgreichen Status vortäuschen. Antworten enthalten keine Kontodaten oder Credentials.

Die Kapazität ist vorerst ein Snapshot: kein unvollendeter T3-Run auf diesem Worker, unabhängig von Archivierung und Provider. Abfragefehler ergeben unbekannt. Sie reserviert keine Ressourcen und ersetzt weder Launch-Berechtigungen noch die spätere Workspace-Zuteilung. Hintergrundprozesse außerhalb eines Runs sind damit nicht inventarisiert. Live-Status nach Verbindungsverlust erneut abfragen. Die integrierte Prüfung unter dem tatsächlichen Dienstkonto und ein autorisierter echter Codex-Turn bleiben eigene Abnahmen; Replay-/Service-Fixtures sind kein Codex-Login-Nachweis.

### Headless-Codex für den begrenzten G3-Versuch binden

Nach abgeschlossener Gerätecode-Anmeldung mit der separat unter
`/var/lib/foundry-worker/home/tools/codex-cli` installierten CLI `0.156.1` kann der
Administrator aus dem geprüften Checkout ausführen:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py bind
# Nach abgeschlossenem Worker-Start:
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py status
```

`bind` prüft Version und Login unter dem Dienstkonto, verweigert offene Runs,
Ausführungen und Writer-Reservierungen und legt eine private Konfigurationskopie
unter dem ausgegebenen `/var/lib/foundry-deploy/worker-codex-g3-*` an. Es registriert
`codexG3` über den bestehenden Settings-Service als vorhandene CLI mit eigenem Home;
ein Wrapper verwendet den absoluten Node-Pfad unabhängig vom Dienst-PATH. Anschließend
stoppt es ausschließlich Worker-Target und gemeinsame Slice, prüft erneut offene
Arbeit und bindet die Instanz über den vorhandenen Installer vor dem Neustart.
Eine neue private Git-Fixture innerhalb der erlaubten Wurzel wird ausgegeben.
Kein Projekt-/Thread-Start, kein Modellaufruf und kein Main-Update erfolgen.

`status` fragt `foundry.workerStatus` über einen frischen authentifizierten RPC ab.
Dafür erzeugte lokale T3-Sessions sind kurzlebig und werden nach jedem RPC widerrufen;
Tokens werden weder ausgegeben noch in Argumenten übergeben. `providerReady=true`
beweist die aktuelle Provider-Prüfung, noch keinen erfolgreichen G3-Auftrag.
Nach der Bindung gilt die gemeinsame Writer-Grenze auch für manuelle Starts;
Replay auf diesen verwalteten Checkouts ohne positiven Stop-Nachweis nicht weiterbenutzen.

Bei fehlgeschlagener Installation/Start bleibt der Worker gestoppt. Vor Rücknahme
offene Arbeit abgleichen; Reservierungsjournal und Ausführungsdaten nie löschen.
Die ausgegebene Recovery enthält `installation.json` und die vorherige `settings.json`.
Der Administrator kann bei gestopptem Target/Slice deren `config` als private
Installer-Konfiguration verwenden, die Settings mit Eigentümer `foundry-worker`
und Modus `0600` zurücklegen, den Installer erneut ausführen und erst danach
`daemon-reload` und `start foundry-host.target` ausführen. Das ist eine
Konfigurationsrücknahme, kein Daten-Restore und kein Codex-Logout.

### Begrenzter echter G3-Auftrag

Nach bestätigter Bereitschaft kann der Administrator dem lokalen Prüfer einen
30 Minuten gültigen Worker-Zugang mit `orchestration:read` und
`orchestration:operate` geben. Keine allgemeinen sudo-/Docker-Rechte:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py acceptance-access /srv/foundry-worker/workspaces/g2/g3-acceptance-<konkrete-fixture>
```

Das prüft erneut die eigene saubere Git-Fixture ohne Remotes und fehlende offene
Arbeit. Anfrage und Command-ID werden zusammen mit der lokalen T3-Session in
`~niklas/.cache/foundry-g3-acceptance/worker-access.json` gespeichert, Modus `0600`.
Die Datei enthält ein Secret; nicht anzeigen oder ins Issue kopieren. Die Scopes
gelten für den Worker, die zusätzliche Begrenzung auf genau die Fixture und Anfrage
setzt der geprüfte Runner durch. Ein vorhandener Auftrag wird nicht überschrieben.

Ohne Modellaufruf Projekt und Verbindung vorbereiten:

```sh
node deploy/fork/worker/g3-acceptance.mjs /home/niklas/.cache/foundry-g3-acceptance/worker-access.json prepare
```

Nur nach ausdrücklicher Freigabe des einen Luna-Turns:

```sh
node deploy/fork/worker/g3-acceptance.mjs /home/niklas/.cache/foundry-g3-acceptance/worker-access.json run-one-luna-turn
```

Der Runner speichert vor dem Start eine exklusive Startsperre. Für diese konkrete
Fixture bedient er einzelne native Befehlsfreigaben über den normalen Approval-Service:
eine feste Liste aus Repository-Inspektion, Schreiben und Lesen von `G3.txt`.
Unbekannte Befehle brechen den Lauf ab; keine dauerhafte Session-Freigabe und keine
Änderung des Approval-Modus. Er verwirft die
committete Launch-Antwort an seiner RPC-Eingangsgrenze und schließt die Verbindung;
Wiederverbindung und Retry verwenden exakt die gespeicherte Anfrage. Read, aktive
Lease-Erneuerung und zwei sequenzierte Follow-Streams prüfen den ursprünglichen Run,
einer davon ab bestätigtem `afterSequence`. Ein fertiges Manifest muss Writer-Ende,
Generation, Run und Checkpoint enthalten und bei erneutem Read/Launch-Retry gleich
bleiben. Nach 120 Sekunden wird Cancel angefordert; bei Fehlern ebenfalls. Ein
Cancel-Ack beweist keinen Stop. Kein Ersatzstart; eine vorhandene Startsperre bleibt
auch nach Fehler erhalten. Diese Zeitgrenze ist kein messbares Euro-Limit für eine
Subscription und kann einen unklaren Writer nicht als beendet erklären.

Die `.result.json` neben der Zugangsdatei enthält nur Prüfergebnisse. Der zusätzliche
Administratorlauf bestätigt gegen die echte SQLite genau einen Thread/Run/Attempt,
Manifest-/Checkpoint-Bindung, Git-Objekt und Dateiinhalt unter Dienstkonto und
widerruft die kurzlebige Prüfersession:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py verify-acceptance second-access.json
```

Für einen gesonderten Neustartnachweis nach bestätigtem Ende aller Writer:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py restart-idle
# Nach dem Start:
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py status
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py verify-acceptance second-access.json
```

`restart-idle` verweigert aktive/unaufgelöste Runs und Reservierungen, speichert die
Ausführungszeilen privat, stoppt ausschließlich das Worker-Target und dessen Slice
und bestätigt leere Dienst-cgroups. Vor dem Start müssen die Ausführungszeilen
unverändert sein. Es startet keinen Modell-Turn und ändert keine Konfiguration.
Die danach ausgeführte Verifikation liest den ursprünglichen Ergebnis-Checkpoint
und die persistierten Zählungen erneut. Das ist kein Restart eines aktiven oder
unklaren Writers und kein Daten-Restore; diese Fälle behalten ihre eigenen Nachweise.

### Aktiver Crash-/Recovery-Nachweis

Dieser gesonderte Betreiberlauf startet **einen weiteren echten Luna-Turn** in
einem neuen eigenen Git-Fixture. Er benötigt eine begrenzte Turn-Freigabe und ein
freies Zeitfenster für genau die Foundry-Worker-Dienste. Beide bereits verbundenen
Clients können währenddessen zur Wiederverbindungsprüfung geöffnet bleiben.

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py active-restart-start
# Nach dem Start:
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py status
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py active-restart-verify
```

Der Start verweigert aktive/ungeklärte Arbeit. Er hält die Anfrage vor dem Senden
privat fest und bestätigt über den Thread-Ereignisstrom einen Pending-Command mit
nativer Request- und Turn-Bindung; keine Befehlsfreigabe wird erteilt. Dieser
Meilenstein hat eine 40-Sekunden-Frist, bei fehlendem Nachweis wird nur der eigene
Auftrag abgebrochen und kein Dienst-Crash durchgeführt. Nach positiver Prüfung
der tatsächlichen Dienst-UID/cwd/cgroup beendet `systemctl kill --kill-whom=all
--signal=SIGKILL` ausschließlich `foundry-host.service` und
`foundry-connector.service`. Danach stoppt der Helfer Target/Slice, bestätigt leere
Dienst-cgroups und startet denselben Worker mit unverändertem Zustand.

`active-restart-verify` liest den ursprünglichen Auftrag, wiederholt exakt dessen
Launch-Anfrage und prüft dieselbe Generation, dasselbe Receipt und genau einen
Run/Attempt/nativen Turn. Ohne bestätigtes Writer-Ende und gültiges Stop-Manifest
muss die Workspace-Reservation erhalten bleiben; ein wieder aktiver oder freigegebener
unklarer Writer ist ein Fehler. Positiver nativer Stop darf ein `stopped`-Manifest
liefern. Prozessende durch den Betreiber wird nicht direkt in die Ausführungs- oder
Reservierungsdatenbank geschrieben. Kein Ersatzauftrag und keine Freigabe durch
Löschen des Journals. Der Prüfzeiger `/var/lib/foundry-deploy/g3-active-restart.json`
verhindert einen zweiten kostenpflichtigen Start; bei Fehlern den ausgegebenen
privaten Record für die gezielte Recovery behalten.

Bleibt die Ausführung nach dem Crash unklar, kann der Administrator die native
Historie des ursprünglichen Threads lesen:

```sh
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py inspect-native-restart
```

Der Prüfer verwendet genau die persistierte native Thread-/Turn-Bindung dieses
Auftrags und die eingerichtete Worker-CLI. Ein kurzlebiger App-Server führt nur
`initialize` und `thread/read` aus, niemals `thread/resume` oder `turn/start`.
Vollständige Turns, laufende Commands und in der Historie referenzierte Kinder
werden geprüft; fehlende oder laufende Daten bestätigen keinen Stop. Die Ausgabe
enthält nur Status/Zählungen, keine Historientexte oder Credentials. Eigene
Probe-Prozesse werden anhand der beim Start erfassten Prozessgruppe beendet.
Das Ergebnis ist Diagnose, keine automatische Reservation-Freigabe. Ein unklarer
Altversuch bleibt bis zum belegten Service-Recovery-Pfad gesperrt.

Für den bestätigten nativen Stop kann ein sauberes Recovery-Release bereitgestellt
werden: Produktionspaket als `worker-release.tar.gz` und `release.json` mit
vollständiger `revision` und Archiv-`sha256`. Der begrenzte Helfer prüft Metadaten,
Archivpfade, ursprüngliche Ausführungsbindung und native Historie erneut. Er
verweigert andere aktive/ungeklärte Arbeit, installiert ausschließlich den Worker,
prüft den Einstieg unter dessen Dienst-UID und hält vor dem Update private
Konfigurations-/SQLite-Snapshots fest. Main und Credentials werden nicht geändert.

```sh
python3 -I deploy/fork/worker/install-g3-recovery.py /path/to/stage --check
sudo /usr/bin/python3 -I deploy/fork/worker/install-g3-recovery.py /path/to/stage
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py status
sudo /usr/bin/python3 -I deploy/fork/worker/bind-codex-g3.py active-recovery-verify
```

Nach dem Start erhebt `foundry.workerRead` seinen eigenen nativen Nachweis über
die ursprüngliche Codex-Instanz. Es öffnet dafür den Harness, ohne den Thread oder
einen Turn fortzusetzen. Erst Writer-Ende plus unveränderliches Stop-Manifest
erlauben dem bestehenden Reconciler die Workspace-Freigabe. Der letzte Prüfschritt
verlangt auch die freigegebene Reservation und genau den ursprünglichen
Run/Attempt/nativen Turn; kein Ersatzauftrag, keine direkten SQLite-Änderungen.

Diese Teilprobe schließt G3 nicht allein: Cancel während Ausführung, Lease-Verlust,
Restart, Writer-Konflikte und Wiederverbindung der Clients bleiben eigene Nachweise.

## Idempotenter Worker-Launch

Worker mit Capability `foundryWorkerLaunch` nehmen `foundry.workerLaunch` über die vorhandene authentifizierte RPC-Verbindung an. Der gemeinsame Client-Command `serverEnvironment.launchFoundryWorker` benötigt `orchestration:operate` auf dem Ziel. Der Aufrufer speichert **vor dem Senden** seine Command-ID und wiederholt nach verlorener Antwort exakt dieselbe Anfrage: `commandId`, `projectId`, `title`, `model`, `prompt`. Das Receipt enthält Thread-ID, Annahmezeit und Sequenz des dauerhaft akzeptierten ersten Messages. Es bestätigt die Annahme, weder erfolgreichen Provider-Start noch Task-Abschluss.

Die erste Ausführung benötigt die explizite Codex-Bindung, bestätigte Provider-Bereitschaft und normale projektbezogene Provider-Freigabe. Der Installer übergibt seine Workspace-Wurzeln auch an diesen Service. Das Projekt muss nach kanonischer Pfadauflösung darin liegen; Scratch und fremde Projektwurzeln werden abgewiesen. Dieser erste Einstieg nutzt ausschließlich die Projektwurzel, `approval-required` und den bestehenden ThreadLaunchService. Worktree-/Writer-Zuteilung folgt später; der Kapazitätssnapshot reserviert auch hier keinen Platz. Dies ist keine Sandbox-Garantie.

Ein akzeptierter Message-Commit liefert bei Wiederholung dasselbe Receipt, auch nach zwischenzeitlicher Provider-Deaktivierung, und startet dabei nichts neu. Ein nur teilweise angelegter Thread wird hingegen erst nach erneuter Provider-Freigabe fortgesetzt. Geänderte Anfrage oder Provider-Bindung unter derselben Command-ID erzeugt einen Konflikt. Die bestehenden Orchestrator-Receipts und Recovery-Pfade bleiben autoritativ; keine zweite Receipt-Datenbank, keine Eltern-Agenten und keine eigene Prozessstartlogik.

Der RPC ist ein expliziter Client-/Service-Einstieg, keine Automation-Engine und keine Freischaltung des Device-Flags `automationExecution`. Es gibt noch keine neue Launch-Oberfläche oder Factory-Dispatch-Anbindung. Bereits akzeptierte Runs bleiben über die normalen T3-Ansichten sichtbar. Aufbewahrung und Sicherung des Worker-T3-State sind Voraussetzung dafür, dass alte Command-IDs wiedererkannt werden.
