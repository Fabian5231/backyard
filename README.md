# Backyard Streams

Eine Seite, auf der alle Livestreams (z. B. jedes Land bei der Backyard Ultra Team-WM) nebeneinander laufen –
jeder Stream lässt sich per Knopf stumm/laut schalten.

## Funktionen

- Beliebig viele Streams im Raster, alle starten **stumm** (sonst blockiert der Browser Autoplay)
- Pro Stream: **Stumm/Laut**, **Solo** (nur diesen hören), Lautstärke, ⤢ größer anzeigen
- **„Nur einer laut“** (oben): Einschalten eines Streams schaltet die anderen automatisch stumm
- **Alle stumm**, Spaltenanzahl wählbar
- Tastatur: `1`–`9` Stream laut/stumm, `Shift`+`1`–`9` Solo, `M` alle stumm
- Stream-Liste wird auf dem Server gespeichert (`data/streams.json`) – gilt für alle Geräte; Bearbeiten mit Passwort
- Läuft eine Einbettung nicht, zeigt die Kachel **den Grund** und einen Link zum Anbieter
- **Diagnose** je Eintrag im Editor: der Server fragt beim Anbieter nach, warum ein Link nicht läuft
- Optional: **Browser-Wiedergabe** für eigene oder ausdrücklich freigegebene Quellen
  (serverseitiger Browser, Übertragung per WebRTC) – standardmäßig aus,
  siehe [docs/BROWSER_PLAYBACK.md](docs/BROWSER_PLAYBACK.md)
- Unterstützte Links:
  - YouTube: `watch?v=…`, `youtu.be/…`, `/live/…`, `/channel/UC…`, `/@name`
  - Twitch: `twitch.tv/kanal`, `twitch.tv/videos/…`
  - Alles andere wird als normales iframe eingebunden (Ton dann nur im Player selbst steuerbar)

## Installation mit Docker (empfohlen)

```bash
git clone https://github.com/Fabian5231/backyard.git /opt/backyard-streams
cd /opt/backyard-streams
cp .env.example .env
nano .env                      # ADMIN_PASSWORD setzen
docker compose up -d --build
```

Updates später: `git pull && docker compose up -d --build`

Die App lauscht danach auf `127.0.0.1:8080`. Davor einen Reverse-Proxy mit HTTPS setzen,
z. B. Caddy (siehe `Caddyfile.example`):

```
streams.deine-domain.de {
	reverse_proxy 127.0.0.1:8080
}
```

> **HTTPS + eigene Domain sind wichtig:** Twitch-Embeds funktionieren nur über HTTPS mit einem
> echten Hostnamen, und YouTube verlangt eine echte Origin. Eine reine IP-Adresse mit http://
> wird von Twitch abgelehnt – die Kachel sagt das dann auch so.

> **Wenn der Reverse-Proxy eigene Header setzt:** `Referrer-Policy: no-referrer` bricht die Embeds
> von YouTube und Twitch. Eine CSP braucht mindestens
> `frame-src https://www.youtube.com https://player.twitch.tv`,
> `script-src https://www.youtube.com https://player.twitch.tv` und `media-src blob:`.
> Die Anwendung selbst sendet keine CSP und setzt `Referrer-Policy: strict-origin-when-cross-origin`.

## Ohne Docker

Benötigt nur Node.js ≥ 18, keine weiteren Pakete:

```bash
ADMIN_PASSWORD=geheim PORT=8080 node server.js
```

Als Dienst: `backyard-streams.service` nach `/etc/systemd/system/` kopieren, Pfad/Passwort anpassen,
`chown -R www-data /opt/backyard-streams/data`, dann `systemctl enable --now backyard-streams`.

Tests: `npm test` (nur Node-Standardbibliothek, kein Docker nötig).

## Einstellungen (Umgebungsvariablen)

| Variable         | Standard  | Bedeutung                                                 |
|------------------|-----------|-----------------------------------------------------------|
| `PORT`           | `8080`    | Port des Servers                                          |
| `HOST`           | `0.0.0.0` | Adresse, auf der gelauscht wird                           |
| `ADMIN_PASSWORD` | *(leer)*  | Passwort zum Bearbeiten der Liste. Leer = jeder darf ändern |
| `DATA_DIR`       | `./data`  | Speicherort von `streams.json`                            |
| `BROWSER_PLAYBACK` | `0`     | Zusatzmodus Browser-Wiedergabe einschalten ([Doku](docs/BROWSER_PLAYBACK.md)) |

Die Stream-Liste kann man auch direkt in `data/streams.json` pflegen:

```json
[
  { "id": "de", "name": "🇩🇪 Deutschland", "url": "https://www.youtube.com/watch?v=VIDEO_ID" },
  { "id": "be", "name": "🇧🇪 Belgien",     "url": "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx" }
]
```

## Wenn ein Stream nicht läuft

Im Editor hat jeder Eintrag einen Knopf **Diagnose**. Der Server fragt beim Anbieter nach und
zeigt, was dort gemeldet wird – etwa ob der Rechteinhaber die Einbettung abgeschaltet hat.
Das lässt sich nicht umgehen; in solchen Fällen hilft nur der Link zum Anbieter oder,
bei eigenen Quellen, die [Browser-Wiedergabe](docs/BROWSER_PLAYBACK.md).

**Zu Kanal-Links:** `/channel/UC…` und `/@name` werden über das alte YouTube-Verfahren
`/embed/live_stream` eingebunden. Das kann den laufenden Stream eines Kanals zeigen, ist aber
von YouTube nicht zugesichert und antwortet für viele Kanäle nicht. Läuft gerade kein Stream
oder antwortet YouTube nicht, bleibt die Kachel leer. **Verlässlich ist nur der direkte Link
des laufenden Streams** – der ändert sich bei YouTube allerdings mit jedem Neustart.
Welche Variante gerade trägt, zeigt die Diagnose.
