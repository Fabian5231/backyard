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
- Unterstützte Links:
  - YouTube: `watch?v=…`, `youtu.be/…`, `/live/…`, `/channel/UC…` (zeigt automatisch den aktuellen Livestream des Kanals), `/@name`
  - Twitch: `twitch.tv/kanal`, `twitch.tv/videos/…`
  - Alles andere wird als normales iframe eingebunden (Ton dann nur im Player selbst steuerbar)

## Installation mit Docker (empfohlen)

```bash
# Ordner auf den VPS kopieren, z. B. nach /opt/backyard-streams
cd /opt/backyard-streams
nano docker-compose.yml        # ADMIN_PASSWORD ändern
docker compose up -d --build
```

Die App lauscht danach auf `127.0.0.1:8080`. Davor einen Reverse-Proxy mit HTTPS setzen,
z. B. Caddy (siehe `Caddyfile.example`):

```
streams.deine-domain.de {
	reverse_proxy 127.0.0.1:8080
}
```

> **HTTPS + eigene Domain sind wichtig:** Twitch-Embeds funktionieren nur über HTTPS, und YouTube
> verlangt eine echte Origin. Eine reine IP-Adresse mit http:// kann Probleme machen.

## Ohne Docker

Benötigt nur Node.js ≥ 18, keine weiteren Pakete:

```bash
ADMIN_PASSWORD=geheim PORT=8080 node server.js
```

Als Dienst: `backyard-streams.service` nach `/etc/systemd/system/` kopieren, Pfad/Passwort anpassen,
`chown -R www-data /opt/backyard-streams/data`, dann `systemctl enable --now backyard-streams`.

## Einstellungen (Umgebungsvariablen)

| Variable         | Standard  | Bedeutung                                                 |
|------------------|-----------|-----------------------------------------------------------|
| `PORT`           | `8080`    | Port des Servers                                          |
| `ADMIN_PASSWORD` | *(leer)*  | Passwort zum Bearbeiten der Liste. Leer = jeder darf ändern |
| `DATA_DIR`       | `./data`  | Speicherort von `streams.json`                            |

Die Stream-Liste kann man auch direkt in `data/streams.json` pflegen:

```json
[
  { "id": "de", "name": "🇩🇪 Deutschland", "url": "https://www.youtube.com/watch?v=VIDEO_ID" },
  { "id": "be", "name": "🇧🇪 Belgien",     "url": "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx" }
]
```

## Tipp

Wenn ein Land seinen Stream neu startet, ändert sich bei YouTube oft die Video-ID. Mit dem **Kanal-Link**
(`/channel/UC…` oder `/@name`) wird immer automatisch der aktuelle Livestream des Kanals gezeigt.
