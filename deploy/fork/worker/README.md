# Isolierter Foundry-Host-Worker

Der Installer verwaltet ausschließlich die vier `foundry-host`-/`foundry-connector`-System-Units. Er erstellt weder Benutzer noch Provider-Anmeldungen, lädt keine Releases herunter und startet keinen Dienst. Main und persönliche T3-Dienste bleiben getrennt. Voraussetzung für die Aktivierung bleibt die G2-Abnahme; Entwicklung des Installers ersetzt sie nicht.

## Vorbereitung

Auf einer freigegebenen Linux-Maschine legt ein Administrator Konto und Gruppe `foundry-worker` an: eigenes Home `/var/lib/foundry-worker/home`, nicht interaktive Shell (`nologin` oder `/bin/false`). Kein vorhandenes Benutzerkonto verwenden. Benötigt werden Node in der vom Repository vorgegebenen Version, Git und die T3-Laufzeitabhängigkeiten. Node muss über einen absoluten Pfad unter `/usr` oder `/opt` erreichbar sein. NVM unter einem persönlichen Home ist absichtlich ausgeschlossen. Der Dienst lädt keine Shell-Startdateien; sein PATH ist `/opt/foundry-worker/providers/bin:/usr/local/bin:/usr/bin:/bin`. Provider-Anmeldung/Bereitschaft folgt separat.

Aus einem sauberen, gepinnten Checkout `vp run foundry:build server` ausführen. Der Build schreibt `apps/server/dist/foundry-build.json` mit Fork, Commit und Dirty-Status. Wie beim bestehenden Foundry-Container das Produktionspaket erzeugen:

```sh
pnpm --config.allow-unused-patches=true --filter t3 deploy --prod --legacy /path/to/output
```

Das vollständige Paket einschließlich `dist`, Metadaten und produktiven Dependencies administrativ unter `/opt/foundry-worker/releases/<vollständiger-commit>/` ablegen. Release und Runtime bleiben root-eigen und für das Dienstkonto unveränderlich; keine Symlinks aus dem Paket in persönliche Checkouts. Der Installer akzeptiert passende Metadaten eines sauberen Foundry-Builds. Diese sind ein Herkunftshinweis, keine kryptographische Signatur; sichere Bereitstellung bleibt Betreiberaufgabe.

Eine Konfigurationsdatei enthält genau die folgenden Felder. Zahlen sind Beispielwerte, kein festgelegtes Produktionsbudget:

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

Dies ersetzt **nicht** Start/Neustart, Ressourcenbegrenzung und Erreichbarkeitsprüfung unter dem echten Dienstkonto. Offene G1/G2/P13-Nachweise stehen in [Issue #13](https://github.com/niklaskastning/foundry/issues/13).

## Codex im Worker einrichten und prüfen

Der Betreiber richtet Codex über die vorhandenen Provider-Einstellungen **dieses Workers** ein: lokalen Worker-Zugriff über einen geschützten Tunnel herstellen, mit einer eigenen lokalen T3-Session koppeln und unter Settings → Providers installieren/anmelden. Diese Session benötigt die normalen Provider-Verwaltungsrechte; der Main-Gateway-Zugang reicht dafür nicht aus. Alle Konfiguration und Anmeldung gehören zum Dienstkonto `foundry-worker` und dessen Home, niemals zum persönlichen T3-Profil. Keine bestehenden Credentials kopieren, keine API-Abrechnung automatisch aktivieren. Eine Installation oder Anmeldung startet noch keinen Agent-Turn.

Die dort gewählte Codex-Instanz-ID als optionales `providerInstanceId` in die Installer-Konfiguration aufnehmen, beispielsweise `"providerInstanceId": "codex"` für die tatsächlich vorhandene Standardinstanz. Dienst stoppen und das oben beschriebene Update-Verfahren ausführen. Der Installer erhält die explizite Bindung im Manifest und den Units über Neustarts und Updates; er wählt bei gelöschter/deaktivierter Instanz keinen Ersatz. Ohne dieses Feld bleibt der Worker ausdrücklich ungebunden. Provider-Konfiguration und Credential-Speicherung verwenden die bestehenden T3-Dienste im Worker-State.

Nach Auswahl des Devices in Connections prüft **Check selected worker** über dessen bestehende RPC-Verbindung die gebundene Instanz neu. Online, Provider-Bereitschaft und Kapazität sind getrennt. Fehlendes Binary, fehlende/unklare Anmeldung und unbekannte oder inkompatible Versionen ergeben keine Bereitschaft. Bei einem fehlgeschlagenen Probe darf ein älterer Registry-Cache keinen erfolgreichen Status vortäuschen. Antworten enthalten keine Kontodaten oder Credentials.

Die Kapazität ist vorerst ein Snapshot: kein unvollendeter T3-Run auf diesem Worker, unabhängig von Archivierung und Provider. Abfragefehler ergeben unbekannt. Sie reserviert keine Ressourcen und ersetzt weder Launch-Berechtigungen noch die spätere Workspace-Zuteilung. Hintergrundprozesse außerhalb eines Runs sind damit nicht inventarisiert. Live-Status nach Verbindungsverlust erneut abfragen. Die integrierte Prüfung unter dem tatsächlichen Dienstkonto und ein autorisierter echter Codex-Turn bleiben eigene Abnahmen; Replay-/Service-Fixtures sind kein Codex-Login-Nachweis.
