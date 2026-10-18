# Browser-Wiedergabe (optionaler Zusatzmodus)

Dieses Dokument beschreibt zuerst, **warum** einzelne Streams in der normalen
Einbettung nicht laufen, und danach den optionalen Zusatzmodus, der eine
Wiedergabeseite in einem serverseitigen Browser öffnet und Bild und Ton per
WebRTC an eine Kachel im Frontend überträgt.

Die direkten Embeds bleiben der Standard. Der Zusatzmodus ist aus, solange er
nicht ausdrücklich eingeschaltet wird.

---

## 1. Bisherige Architektur

```
Browser des Zuschauers
   public/index.html + app.js
      ├─ YouTube-Kachel  → <iframe> youtube.com/embed/…  + YouTube IFrame API
      ├─ Twitch-Kachel   → Twitch Embed SDK (player.twitch.tv/js/embed/v1.js)
      └─ sonstige Kachel → <iframe src="…"> (kein Zugriff auf den Ton)
         ↕ /api/streams, /api/resolve
   server.js  (Node ohne Abhängigkeiten)
      └─ data/streams.json
```

Alle Kacheln bekommen im Frontend dieselbe kleine Schnittstelle:

```js
tile.player = { mute(), unmute(), setVolume(0..100) }
```

Darauf setzen **Stumm/Laut, Solo, Lautstärke, Alle stumm, Nur einer laut** und
die Tastenkürzel auf. Jede neue Wiedergabeart muss nur diese drei Methoden
liefern – genau das macht die Browser-Wiedergabe. Deshalb funktionieren alle
bestehenden Bedienelemente unverändert weiter.

---

## 2. Konkrete Fehlerursachen

### 2.1 Fehler in der Konfiguration bzw. im Code (behoben)

| Ursache | Wirkung vorher | Behebung |
|---|---|---|
| `YT.Player` wurde ohne `onError` angelegt | Bei abgeschalteter Einbettung (Fehler 101/150) kam `onReady` nie. Die Kachel blieb schwarz, der Stumm-Knopf dauerhaft inaktiv, **ohne jede Meldung**. | `onError` mit Übersetzung aller Fehlercodes in Klartext, plus Frist von 20 s |
| Das `onReady`-Promise hatte keine Frist | Jeder Fehlschlag ohne Fehlercode führte zu einer Kachel, die für immer „lädt“. | `withTimeout()` um beide Player |
| Ladefehler von `iframe_api` wurde verworfen | `loadScript()` lehnte ab, aber `ytReady` wartete weiter. Unbehandelte Rejection, Kachel hängt. | `Promise.race` aus Ladefehler und Ready-Signal |
| Twitch ohne jede Fehlerbehandlung | Kein `READY` → Kachel hängt; kein Hinweis auf offline oder untersagte Einbettung. | Frist, `OFFLINE`/`ONLINE`-Auswertung, Klartextmeldung |
| Twitch-Voraussetzungen wurden nicht geprüft | Twitch verweigert Embeds ohne HTTPS und mit einer IP als `parent`. Sichtbar war nur ein schwarzes Rechteck. | Prüfung von `location.protocol` und Hostname **vor** dem Laden, mit konkreter Anweisung |
| Keine `Referrer-Policy` | Setzt ein Reverse-Proxy `no-referrer`, lehnen YouTube und Twitch die Einbettung ab – schwer zu finden. | Server sendet ausdrücklich `strict-origin-when-cross-origin` |
| Fremde iframes ohne Ausweg | `X-Frame-Options`/`frame-ancestors` der Gegenseite lässt sich im Frontend **nicht** erkennen: kein Event, kein Fehler. | Dauerhafter Link „Lädt nicht? Beim Anbieter öffnen“ in der Kachel |
| `/api/resolve` war offen | Jeder konnte den Server fremde Seiten abrufen lassen. | Nur noch für Admins |

Zur Einordnung der einzelnen Mechanismen:

* **Origin** – `enablejsapi=1` verlangt den Parameter `origin`. Der war korrekt
  gesetzt (`location.origin`) und ist **nicht** die Ursache der Ausfälle. Neu
  hinzugekommen ist `widget_referrer`, der offizielle Parameter, mit dem YouTube
  die einbettende Seite zugeordnet bekommt.
* **Referrer** – wird vom Browser standardmäßig passend gesendet. Ein Problem
  entsteht erst durch einen strengeren Header. Dagegen schützt die jetzt
  ausdrücklich gesetzte Policy.
* **CSP** – `server.js` sendet selbst keine CSP. Eine CSP vom Reverse-Proxy kann
  die Embeds trotzdem brechen; sie braucht mindestens
  `frame-src https://www.youtube.com https://player.twitch.tv`,
  `script-src https://www.youtube.com https://player.twitch.tv` und
  `media-src blob:`.
* **Twitch `parent`** – `parent: [location.hostname]` ist richtig, solange die
  Seite die oberste ist. Entscheidend sind HTTPS und ein echter Hostname.
* **Player-Konfiguration** – `autoplay=1` zusammen mit `mute=1` ist korrekt:
  jeder Browser blockt Autoplay mit Ton. Deshalb starten alle Kacheln stumm.

### 2.2 Einschränkungen des Anbieters (nicht behebbar)

Diese Fälle sind **keine** Konfigurationsfehler. Sie lassen sich nur klar
melden, nicht umgehen:

* Der Rechteinhaber hat die Einbettung abgeschaltet (`playableInEmbed: false`,
  YouTube-Fehler 101/150).
* Das Video ist privat, gelöscht oder regional gesperrt.
* Die Seite verbietet das Einbetten per `X-Frame-Options` oder
  `frame-ancestors`.

In allen diesen Fällen zeigt die Kachel jetzt den Grund und einen Link zum
Anbieter.

### 2.3 Kanal-Links: was wirklich passiert

Die bisherige README versprach, ein Kanal-Link zeige „immer automatisch den
aktuellen Livestream“. Das gibt die Implementierung nicht her, und so steht es
jetzt auch nicht mehr da. Tatsächlich passiert:

1. `youtube.com/@name` wird **einmal beim Speichern** serverseitig zu einer
   Kanal-ID aufgelöst (`/api/resolve`, Auslesen von `canonical`/`externalId`).
   Das ergibt die Kanal-ID – **nicht** einen laufenden Stream.
2. `/channel/UC…` wird im Frontend zu
   `https://www.youtube.com/embed/live_stream?channel=UC…`.

Schritt 2 ist ein altes YouTube-Verfahren. Es ist nicht dokumentiert zugesichert
und antwortet für viele Kanäle nicht. Läuft kein Stream oder beantwortet YouTube
die Anfrage nicht, bleibt die Kachel leer – das ist erwartbar, kein Fehler
dieser Anwendung. Verlässlich ist nur der direkte Link des laufenden Streams.

Für Twitch fragt diese Anwendung **keine** API ab. Ob ein Kanal live ist, weiß
sie nicht; sie zeigt lediglich, was der Player meldet.

### 2.4 Diagnose im Betrieb

Im Editor hat jeder Eintrag einen Knopf **Diagnose** (nur für Admins,
`GET /api/diagnose?url=…`). Der Server fragt beim Anbieter nach und zeigt die
Rohwerte zusammen mit ihrer Deutung:

* YouTube-Video: oEmbed-Status, `playableInEmbed`, `playabilityStatus` und der
  von YouTube genannte Grund.
* YouTube-Kanal: ob `/embed/live_stream` gerade eine Video-ID liefert.
* Twitch: Erreichbarkeit der Kanalseite und die Voraussetzungen der Einbettung.
  Der Live-Status bleibt offen – dafür wäre die Helix-API mit eigener Client-ID
  nötig, die hier bewusst nicht eingebaut ist.

Der Endpunkt ruft nur youtube.com und twitch.tv ab, damit er nicht als offener
Abruf-Dienst missbraucht werden kann.

---

## 3. Der Zusatzmodus: Aufbau

```
Container "backyard-streams"                Container "backyard-browser"
┌──────────────────────────────┐            ┌──────────────────────────────────────┐
│ server.js                    │            │ entrypoint.sh                        │
│  /api/browser/sessions  ─────┼──────────► │  service.js   (Sitzungen, Limits)    │
│  …/whep  (SDP)          ─────┼──────────► │    │                                 │
│  …/keepalive, …/close   ─────┼──────────► │    ├─ Xvfb :10x   1280x720x24         │
│                              │  internes  │    ├─ PulseAudio: Null-Senke je       │
│  prüft: Passwort, Rate,      │  Docker-   │    │               Sitzung            │
│  Stream-Id → URL aus         │  Netz      │    ├─ Chromium --kiosk (Software-GL)  │
│  streams.json                │            │    │    alle Anfragen →               │
└──────────────────────────────┘            │    │    Egress-Proxy (127.0.0.1)      │
                                            │    └─ ffmpeg x11grab + pulse.monitor  │
                                            │         └─ RTSP → MediaMTX (loopback) │
                                            │              └─ WHEP/WebRTC           │
                                            └───────────────┬──────────────────────┘
                                                            │ ICE: UDP+TCP 8189
Browser des Zuschauers ◄────────── Bild + Ton (WebRTC) ──────┘
   <video> in der Kachel, Ton lokal regelbar
```

Ablauf einer Sitzung:

1. Die Kachel ruft `POST /api/browser/sessions` mit der **Stream-Id** auf.
2. `server.js` prüft das Zuschauer-Passwort und die Rate, sucht den Stream in
   `data/streams.json` und prüft, dass `mode: "browser"` gesetzt ist. Die
   Ziel-URL kommt ausschließlich aus dieser Liste.
3. Der Browser-Dienst prüft die URL gegen die Hostfreigabe, startet Xvfb, eine
   eigene Audio-Senke, Chromium und ffmpeg und gibt eine Sitzungs-Id und ein
   Sitzungs-Token zurück.
4. Die Kachel handelt per WHEP (ein HTTP-POST mit SDP) die WebRTC-Verbindung
   aus und hängt den Stream an ein `<video>`.
5. Solange die Kachel offen ist, meldet sie sich alle 25 s. Bleibt die Meldung
   aus, räumt der Server die Sitzung ab.

### Warum dieser Weg

* **WebRTC** war gefordert und ist hier auch die richtige Wahl: geringste
  Verzögerung und getrennte Audio-/Videospuren, die der Zuschauer-Browser
  lokal regeln kann.
* **Aufnahme per X11 und PulseAudio statt `getDisplayMedia`.** Chromium kann
  unter Linux bei Bildschirmaufnahme **keinen** Ton mitnehmen; Audio gibt es
  nur bei Tab-Aufnahme, und die verlangt den Tab-Titel schon beim Start des
  Browsers. Der Umweg über X11-Bild und die Monitor-Quelle der Audio-Senke ist
  deshalb der verlässliche Weg und braucht keine Automatisierung im Browser.
* **MediaMTX** macht aus dem RTSP-Strom WebRTC. Eine einzelne statische
  Binärdatei mit festgenagelter Prüfsumme; WHEP ist ein schlichter HTTP-POST
  und lässt sich dadurch über den bestehenden Reverse-Proxy authentifiziert
  weiterreichen.
* **Keine Automatisierungsbibliothek.** Chromium wird mit `--kiosk <url>`
  gestartet, sonst nichts. Kein Playwright, kein Puppeteer, kein CDP-Port.
  Dadurch gibt es auch keinen Debug-Port und `navigator.webdriver` bleibt
  unverfälscht – wir verstellen nichts, um wie ein anderer Browser zu wirken.
* **noVNC** ist nicht eingebaut. Es überträgt keinen Ton und wäre für diese
  Aufgabe die falsche Grundlage.

### Verworfene Alternativen

* **`getDisplayMedia` im Browser selbst** – wäre weniger Code, scheitert aber
  unter Linux am Ton (siehe oben).
* **fragmentiertes MP4 über HTTP + MSE** – bräuchte MediaMTX nicht und käme
  durch jede Firewall, hätte aber 1–3 s Verzögerung statt WebRTC-Latenz.
  MediaMTX kann das bei Bedarf zusätzlich liefern (`hls: true`); dann ist auch
  Safari ohne WebRTC versorgt.
* **noVNC/VNC** – kein Ton.

---

## 4. Zusätzliche Abhängigkeiten

Die Hauptanwendung bleibt **ohne npm-Abhängigkeiten**. Alles Neue steckt im
zweiten Container:

| Baustein | Herkunft | Zweck |
|---|---|---|
| chromium | Debian-Paket | Wiedergabeseite anzeigen |
| xvfb | Debian-Paket | X-Display ohne Grafikkarte |
| pulseaudio | Debian-Paket | Null-Senke je Sitzung, Ton abgreifen |
| ffmpeg | Debian-Paket | Bild und Ton aufnehmen und kodieren |
| mediamtx | GitHub-Release, SHA256 im Dockerfile | RTSP → WebRTC (WHEP) |
| dumb-init | Debian-Paket | Signale und Zombie-Prozesse |

`browser/service.js` und die Module unter `browser/lib/` verwenden nur die
Node-Standardbibliothek.

---

## 5. Einstellungen

Alle Angaben in `.env`. Der Browser-Container startet nur mit dem Profil
`browser`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `BROWSER_PLAYBACK` | `0` | Zusatzmodus in der Hauptanwendung einschalten |
| `BROWSER_SERVICE_TOKEN` | – | **Pflicht.** Gemeinsames Geheimnis beider Container (`openssl rand -hex 32`) |
| `BROWSER_PUBLIC_HOST` | – | **Pflicht.** Öffentlicher Name/IP für die ICE-Kandidaten |
| `BROWSER_ALLOWED_HOSTS` | *(leer)* | Freigegebene Hosts, komma-getrennt. Ein Eintrag deckt Subdomains ab. Leer = keine Sitzung möglich |
| `BROWSER_ALLOWED_PRESETS` | *(leer)* | Kurzformen `youtube`, `twitch` für die nötigen Medien-/CDN-Domains |
| `BROWSER_VIEWER_PASSWORD` | *(leer)* | Passwort, das Zuschauer zum Starten brauchen. Leer = jeder Besucher darf starten |
| `BROWSER_MAX_SESSIONS` | `2` | Gleichzeitige Sitzungen |
| `BROWSER_WIDTH` / `BROWSER_HEIGHT` | `1280` / `720` | Auflösung (begrenzt auf 1920×1080) |
| `BROWSER_FPS` | `25` | Bildrate (5–30) |
| `BROWSER_VIDEO_BITRATE` | `2500k` | Obergrenze Video |
| `BROWSER_AUDIO_BITRATE` | `96k` | Opus-Bitrate |
| `BROWSER_VIDEO_CODEC` | `h264` | `h264` (sparsam) oder `vp8` (verträglicher, siehe unten) |
| `BROWSER_IDLE_TIMEOUT` | `90` | Sekunden ohne Lebenszeichen, dann Abbau |
| `BROWSER_MAX_SESSION_SECONDS` | `14400` | Höchstlaufzeit einer Sitzung |
| `BROWSER_STARTS_PER_MINUTE` | `10` | Startversuche je IP und Minute |
| `TRUST_PROXY` | `0` | `X-Forwarded-For` auswerten. **Nur** einschalten, wenn ein eigener Reverse-Proxy davor steht – sonst kann sich jeder eine fremde Adresse zuschreiben. Bleibt es aus, wirkt das Startlimit hinter dem Proxy für alle Zuschauer gemeinsam |
| `BROWSER_CPU_LIMIT` / `BROWSER_MEMORY_LIMIT` | `2.0` / `2g` | Grenzen des Containers |
| `BROWSER_CHROMIUM_NO_SANDBOX` | `0` | Notausgang, falls der Host keine User-Namespaces erlaubt |

### Codec-Wahl

Gemessen (siehe Abschnitt 7): H.264 kostet rund **40 Prozentpunkte eines Kerns
weniger** als VP8. Dafür gilt:

* **H.264** spielt jeder offizielle Browser (Chrome, Edge, Firefox, Safari).
  Chromium-Bauten mancher Linux-Distributionen enthalten **kein** H.264 – dort
  bleibt das Bild aus.
* **VP8** ist in WebRTC zwingend vorgeschrieben und läuft überall, kostet aber
  mehr CPU.

Scheitert die Verbindung mit „codecs not supported by client“, zeigt die Kachel
genau diesen Hinweis. Dann `BROWSER_VIDEO_CODEC=vp8` setzen.

---

## 6. Sicherheit

**Was der Zusatzmodus nicht tut:** Er umgeht kein DRM, keine Paywall, keine
Anmeldung und keine Regionssperre. Er meldet sich nirgends an, speichert keine
Zugangsdaten und verstellt weder User-Agent noch Automatisierungsmerkmale, um
einem Bot-Schutz zu entgehen. Er ist für **eigene Streams** gedacht und für
Quellen, für deren Wiedergabe und Weitergabe eine ausdrückliche Erlaubnis
vorliegt. Wo eine Quelle nicht zulässig unterstützt werden kann, zeigt die
Kachel eine verständliche Meldung und einen Link zum Anbieter.

### Keine beliebigen Seiten

Drei Stufen, jede für sich wirksam:

1. **Zuschauer übergeben keine URL.** `POST /api/browser/sessions` nimmt nur
   eine Stream-Id. Die Adresse holt der Server aus `data/streams.json`, und die
   ist nur mit Admin-Passwort änderbar. Ein mitgeschicktes `url`-Feld hat keine
   Wirkung (durch einen Test abgesichert).
2. **`mode: "browser"` muss am Eintrag stehen** – das setzt nur ein Admin, und
   es wird verworfen, solange der Zusatzmodus nicht läuft.
3. **Hostfreigabe im Browser-Dienst.** Ohne `BROWSER_ALLOWED_HOSTS` bzw.
   `BROWSER_ALLOWED_PRESETS` startet keine Sitzung.

### Kein Zugriff auf interne Dienste

Chromium läuft mit `--proxy-server=http://127.0.0.1:8081` und
`--proxy-bypass-list=<-loopback>`. Dadurch geht **jede** HTTP(S)-Anfrage des
Browsers durch `browser/lib/egress-proxy.js` – auch Unterressourcen, Anfragen
aus Skripten und Weiterleitungen, und ausdrücklich auch solche an localhost.
Der Proxy

* lässt nur freigegebene Hosts durch,
* lehnt interne Namen (`*.internal`, `*.local`, `localhost`, …) und nackte
  IP-Adressen als Ziel ab,
* löst den Namen **selbst** auf, prüft **jede** Antwort-IP gegen die Sperrliste
  (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` mit der
  Cloud-Metadaten-Adresse, `100.64/10`, Multicast, IPv6-ULA/link-local, auch
  IPv4-gemappt wie `::ffff:169.254.169.254`),
* verbindet dann **zur geprüften IP**, nicht erneut per Name – deshalb hilft
  auch DNS-Rebinding nicht,
* erlaubt nur Port 80 und 443,
* zählt blockierte Hosts mit (`GET /health`), damit sichtbar wird, welche
  CDN-Domain einer Plattform noch fehlt.

Zusätzlich liegt eine Chromium-Richtlinie in
`/etc/chromium/policies/managed/backyard.json`: `file://`, `chrome://` und
`devtools://` gesperrt, DevTools aus, Kamera/Mikrofon/Bildschirmaufnahme,
Standort, Benachrichtigungen, Clipboard, USB/Serial/Bluetooth und der
Passwortmanager aus.

### Prozess- und Containerhärtung

* Kein privilegierter Container, `cap_drop: ALL`, `no-new-privileges`.
* **Die Chromium-Sandbox bleibt an.** Sie braucht nur unprivilegierte
  User-Namespaces, keine zusätzlichen Capabilities. Verbietet der Host sie per
  seccomp, kommt in `chrome.log` „Operation not permitted“ beim Start des
  Zone-Prozesses. Dann in dieser Reihenfolge:
  1. unprivilegierte User-Namespaces auf dem Host erlauben
     (`sysctl kernel.unprivileged_userns_clone=1`, bei älteren Kerneln),
  2. ein eigenes seccomp-Profil für Chromium hinterlegen (Zeile in
     `docker-compose.yml` ist vorbereitet),
  3. **erst als letzte Wahl** `BROWSER_CHROMIUM_NO_SANDBOX=1`. Das ist eine
     echte Abschwächung und sollte nur mit ohnehin vertrauenswürdigen Quellen
     passieren.
* Der Container läuft als `backyard` (UID 10001), nicht als root.

### Authentifizierung und Trennung

* Der Steuerdienst liegt **nur** im internen Docker-Netz und verlangt zusätzlich
  `X-Service-Token`. Es gibt keine Portfreigabe dafür nach außen.
* Jede Sitzung hat ein eigenes Zufallstoken; WHEP, Keepalive und Close prüfen es
  zeitkonstant. Ohne Token gibt es kein Bild.
* RTSP und der WHEP-Endpunkt von MediaMTX hören auf `127.0.0.1`. Nach außen ist
  nur der ICE-Port 8189 (UDP + TCP) offen, über den die Medien laufen.
* API, Metriken, pprof und Playback von MediaMTX sind abgeschaltet: **keine
  öffentlich erreichbaren Debug-Ports**, auch kein CDP-Port.
* Jede Sitzung bekommt ein frisches, wegwerfbares Browserprofil, das beim Abbau
  gelöscht wird, und eine eigene Audio-Senke.

**Bewusste Festlegung:** Rufen mehrere Zuschauer denselben Stream auf, teilen
sie **eine** Sitzung – sonst würde jeder Zuschauer einen eigenen Browser kosten.
Tragfähig ist das, weil sich diese Sitzungen nirgends anmelden: anonymes Profil,
keine Zugangsdaten, keine übernommenen Cookies, Profil nach dem Abbau gelöscht.
Es gibt also keine Nutzersitzung, die geteilt werden könnte. Für Quellen, die
eine Anmeldung bräuchten, ist dieser Modus nicht gedacht und nicht geeignet.

---

## 7. Bedarf an CPU, RAM und Bandbreite

Gemessen auf einem Container ohne GPU, 4 vCPU, mit der mitgelieferten
Testquelle (`public/browser-test-source.html`: animiertes Canvas plus Ton),
1280×720 bei 25 fps, Zielbitrate 2500k, Messfenster 20 s:

| | H.264 | VP8 |
|---|---|---|
| Chromium (10 Prozesse) | 50 % eines Kerns | 50 % eines Kerns |
| ffmpeg (Kodierung) | 25 % | 65 % |
| Xvfb | 10 % | 10 % |
| **Summe je Sitzung** | **≈ 85 % eines Kerns** | **≈ 125 % eines Kerns** |
| RSS je Sitzung | ≈ 1,1 GB | ≈ 1,1 GB |
| gemessene Ausgangsbitrate | 1,54 Mbit/s | 0,99 Mbit/s |

**So sind diese Zahlen zu lesen:**

* Es ist eine **Untergrenze**, keine Kapazitätszusage. Die Testquelle ist ein
  einfaches Canvas. Eine echte Videoseite muss das Video zusätzlich in Software
  dekodieren; dann steigt der Anteil von Chromium deutlich – bei 1080p-Quellen
  erfahrungsgemäß auf ein Mehrfaches. Wie viel genau, hängt von der Seite ab
  und **muss auf der eigenen Maschine gemessen werden**:
  `node scripts/smoke-browser-playback.js` zeigt den Aufbau, `docker stats`
  die laufende Last.
* Bandbreite: je Sitzung einmal **Eingang** (der serverseitige Browser lädt den
  Stream) plus **Ausgang je Zuschauer**. Zehn Zuschauer an einer Sitzung mit
  1,5 Mbit/s sind rund 15 Mbit/s ausgehend – MediaMTX ist ein Verteiler, kein
  Mehrfachkodierer, der Encoder läuft nur einmal.
* RAM: 1,1 GB je Sitzung ist viel und kommt fast vollständig von Chromium.
  Mit `BROWSER_MAX_SESSIONS=2` und `BROWSER_MEMORY_LIMIT=2g` ist der Container
  knapp bemessen; bei zwei gleichzeitigen Sitzungen sollte das Limit höher
  liegen (3–4 GB).
* Faustregel für den Start: **ein freier Kern und 1,5 GB RAM je gleichzeitiger
  Sitzung**, dann nachmessen.

---

## 8. Betrieb

```bash
cp .env.example .env
nano .env     # ADMIN_PASSWORD, BROWSER_PLAYBACK=1,
              # BROWSER_SERVICE_TOKEN (openssl rand -hex 32),
              # BROWSER_PUBLIC_HOST, BROWSER_ALLOWED_HOSTS

docker compose --profile browser up -d --build
```

Ohne `--profile browser` startet nur die Hauptanwendung – wie bisher.

In der Firewall muss **Port 8189 für UDP und TCP** offen sein. UDP ist der
normale Weg, TCP der Rückfall für strenge Netze; ohne beides kommt kein Bild an.

Danach im Editor bei einem Eintrag das Häkchen **Browser** setzen. Die Kachel
zeigt dann ein `Browser`-Abzeichen; Stumm/Laut, Solo, Lautstärke, ⤢ und die
Tastenkürzel verhalten sich wie bei allen anderen Kacheln.

### Prüfen

```bash
npm test     # Unit- und Server-Tests, ohne Docker (29 Tests)

# Zustand des laufenden Browser-Dienstes (nur im Container-Netz erreichbar).
# Ohne Dienst-Token kommt nur {"ok":true}; mit Token auch die laufenden
# Sitzungen, die Hostfreigabe und die blockierten Hosts.
docker compose exec backyard-browser sh -c \
  'curl -s -H "X-Service-Token: $BROWSER_SERVICE_TOKEN" http://127.0.0.1:8090/health'
```

Der Rauchtest braucht alle Bausteine. Am einfachsten im Browser-Container, in
den dafür das Repository eingehängt wird:

```bash
docker compose --profile browser run --rm \
  -v "$PWD:/src" -w /src --entrypoint sh backyard-browser -c '
    export XDG_RUNTIME_DIR=/tmp/runtime
    MEDIAMTX_BIN=/usr/local/bin/mediamtx node scripts/smoke-browser-playback.js'
```

Auf einem Host mit `chromium`, `ffmpeg`, `Xvfb`, `pulseaudio` und `mediamtx`
genügt:

```bash
MEDIAMTX_BIN=/pfad/zu/mediamtx npm run smoke:browser
```

Er fährt die echte Aufnahmekette gegen die eigene Testquelle hoch und prüft
messbar: Video- und Audiospur vorhanden, Bild bewegt sich (Szenenwechsel), Ton
hat die erwarteten 440/660 Hz, eine echte WebRTC-Verbindung aus einem zweiten
Browser liefert Bytes in beiden Spuren, und nach `stop()` ist kein Prozess und
keine Audio-Senke übrig.

### Die eigene Testquelle verwenden

`public/browser-test-source.html` wird von der Anwendung selbst ausgeliefert.
Als Browser-Wiedergabe einzurichten:

1. `BROWSER_ALLOWED_HOSTS` um den **öffentlichen** Hostnamen der Anwendung
   ergänzen (z. B. `streams.deine-domain.de`).
2. Im Editor einen Eintrag mit
   `https://streams.deine-domain.de/browser-test-source.html` anlegen und
   **Browser** anhaken.

Der Weg über den öffentlichen Namen ist Absicht: der serverseitige Browser darf
nicht über interne Adressen auf den eigenen Server zugreifen (Abschnitt 6).

### Wenn es nicht läuft

| Beobachtung | Ursache | Abhilfe |
|---|---|---|
| „Die WebRTC-Verbindung ist abgebrochen“ | ICE-Port gesperrt oder `BROWSER_PUBLIC_HOST` falsch | Port 8189 UDP **und** TCP freigeben, Hostnamen prüfen |
| „Dieser Browser kann das Videoformat nicht abspielen“ | Zuschauer-Chromium ohne H.264 | `BROWSER_VIDEO_CODEC=vp8` |
| Schwarzes Bild, Seite lädt nicht | eine CDN-Domain fehlt in der Freigabe | `GET /health` → `blockedHosts` ansehen und ergänzen |
| „Es laufen schon N Browser-Sitzungen“ | `BROWSER_MAX_SESSIONS` erreicht | Grenze erhöhen, wenn CPU und RAM es tragen |
| Chromium startet nicht, „Operation not permitted“ | Sandbox braucht User-Namespaces | siehe Abschnitt 6 |
| Container startet, aber kein Ton | PulseAudio nicht erreichbar | Log des Containers prüfen; `pactl info` im Container |

---

## 9. Offene Punkte

* **Kein TURN-Server.** Der TCP-ICE-Kandidat auf Port 8189 deckt die meisten
  strengen Netze ab. Zuschauer hinter einem Netz, das beides blockt, bekommen
  kein Bild. Wer das braucht, trägt einen TURN-Server in
  `webrtcICEServers2` in `browser/mediamtx.yml` ein.
* **Die CPU-Zahlen stammen von einer einfachen Testquelle.** Für echte
  Videoseiten müssen sie auf der Zielmaschine neu gemessen werden.
* **Einwilligungsbanner** einer Seite landen mit im Bild. Automatisch
  wegzuklicken ist hier bewusst nicht eingebaut.
* **Hostfreigabe-Kurzformen** (`youtube`, `twitch`) sind ein Anfangsbestand;
  Plattformen ändern CDN-Domains. `blockedHosts` in `GET /health` zeigt, was
  fehlt.
* **Safari ohne WebRTC-Weg** wäre über zusätzliches LL-HLS abzudecken
  (`hls: true` in `browser/mediamtx.yml`); nicht eingebaut, weil WebRTC
  gefordert war und Safari WebRTC beherrscht.
* **Live-Status von Twitch** ist ohne Helix-API nicht feststellbar.
