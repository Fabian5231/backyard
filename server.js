// Backyard Streams – kleiner Server ohne Abhängigkeiten.
// Liefert die Weboberfläche aus und speichert die Stream-Liste in data/streams.json.
//
// Optional (BROWSER_PLAYBACK=1) reicht er außerdem die Steuerung der
// Browser-Wiedergabe an den separaten Browser-Container weiter. Die
// Hauptanwendung bleibt dabei ohne npm-Abhängigkeiten.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
// Hinter einem Reverse-Proxy auf 127.0.0.1 setzen. Im Container muss es
// 0.0.0.0 bleiben, sonst kommt das Port-Mapping von Docker nicht an.
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "streams.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- Browser-Wiedergabe (Zusatzmodus, standardmäßig aus) ----------
const BROWSER_PLAYBACK = /^(1|true|yes|on)$/i.test(String(process.env.BROWSER_PLAYBACK || ""));
const BROWSER_SERVICE_URL = process.env.BROWSER_SERVICE_URL || "http://backyard-browser:8090";
const BROWSER_SERVICE_TOKEN = process.env.BROWSER_SERVICE_TOKEN || "";
const BROWSER_VIEWER_PASSWORD = process.env.BROWSER_VIEWER_PASSWORD || "";
// Höchstens so viele Sitzungsstarts pro Minute und IP.
const BROWSER_STARTS_PER_MINUTE = Number(process.env.BROWSER_STARTS_PER_MINUTE) || 10;
// Hinter einem Reverse-Proxy ist die Peer-Adresse immer die des Proxys. Nur mit
// TRUST_PROXY=1 wird X-Forwarded-For ausgewertet – sonst könnte sich jeder eine
// beliebige Adresse zuschreiben und das Limit umgehen.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(String(process.env.TRUST_PROXY || ""));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]\n");

function readStreams() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeStreams(list) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(tmp, DATA_FILE);
}

function sanitize(list) {
  if (!Array.isArray(list)) throw new Error("Liste erwartet");
  if (list.length > 200) throw new Error("Zu viele Streams");
  return list.map((s) => {
    const name = String(s?.name ?? "").trim().slice(0, 80);
    const url = String(s?.url ?? "").trim().slice(0, 500);
    if (!name || !url) throw new Error("Name und URL sind Pflicht");
    if (!/^https?:\/\//i.test(url)) throw new Error("URL muss mit http(s):// beginnen");
    const entry = { id: String(s.id || crypto.randomUUID()).slice(0, 64), name, url };
    // "browser" nur, wenn der Zusatzmodus überhaupt läuft – sonst wäre die
    // Kachel in der Oberfläche dauerhaft kaputt.
    if (s?.mode === "browser" && BROWSER_PLAYBACK) entry.mode = "browser";
    return entry;
  });
}

/** Zeitkonstanter Vergleich eines Headers mit einem Geheimnis. */
function headerMatches(req, header, expectedValue) {
  const given = Buffer.from(String(req.headers[header] || ""));
  const expected = Buffer.from(expectedValue);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    // Ausdrücklich setzen: mit "no-referrer" lehnen YouTube und Twitch die
    // Einbettung ab. Diese Einstellung sendet die Origin und reicht beiden.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Body zu groß"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Begrenzter, abbrechender Abruf – nur für die Diagnose-Endpunkte. */
async function fetchText(url, { limit = 400_000, timeout = 8000 } = {}) {
  const res = await fetch(url, {
    headers: { "Accept-Language": "en", Cookie: "SOCS=CAI; CONSENT=YES+1" },
    signal: AbortSignal.timeout(timeout),
    redirect: "follow",
  });
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        await reader.cancel();
        break;
      }
    }
  }
  return { status: res.status, ok: res.ok, text };
}

// ---------- Diagnose vorhandener Embeds ----------

/**
 * Prüft, warum ein YouTube- oder Twitch-Link in der Einbettung nicht läuft.
 * Gibt Messwerte zurück und trennt sie von der Deutung – geraten wird nicht.
 */
async function diagnose(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: "Keine gültige URL" };
  }
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  const findings = [];
  const result = { url: u.href, host, checks: findings };

  const videoId =
    u.searchParams.get("v") ||
    (host === "youtu.be" ? u.pathname.split("/")[1] : null) ||
    (/^\/(live|embed|shorts|v)\/([^/]+)/.exec(u.pathname)?.[2] ?? null);
  const channelId = /^\/channel\/(UC[\w-]{22})/.exec(u.pathname)?.[1] || u.searchParams.get("channel");

  if (host.endsWith("youtube.com") || host === "youtu.be" || host === "youtube-nocookie.com") {
    result.kind = videoId ? "youtube-video" : channelId ? "youtube-channel" : "youtube-other";

    if (videoId) {
      try {
        const oembed = await fetchText(
          `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)}`,
        );
        findings.push({
          check: "oEmbed",
          status: oembed.status,
          detail: oembed.ok
            ? "YouTube liefert oEmbed-Daten – das Video existiert und ist öffentlich."
            : "oEmbed antwortet mit einem Fehler. Typisch bei privaten, gelöschten oder nicht einbettbaren Videos.",
        });
      } catch (err) {
        findings.push({ check: "oEmbed", status: 0, detail: `Nicht erreichbar: ${err.message}` });
      }

      try {
        const page = await fetchText(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}`);
        const playableInEmbed = /"playableInEmbed":\s*(true|false)/.exec(page.text)?.[1];
        const status = /"playabilityStatus":\{"status":"([A-Z_]+)"/.exec(page.text)?.[1];
        const reason = /"reason":\{"simpleText":"([^"]{0,200})"/.exec(page.text)?.[1]
          || /"reason":"([^"]{0,200})"/.exec(page.text)?.[1];
        findings.push({
          check: "Embed-Seite",
          status: page.status,
          detail: [
            playableInEmbed === undefined ? "Feld playableInEmbed nicht gefunden" : `playableInEmbed=${playableInEmbed}`,
            status ? `playabilityStatus=${status}` : null,
            reason ? `Grund: ${reason}` : null,
          ].filter(Boolean).join(", "),
        });
        if (playableInEmbed === "false") {
          result.verdict = "Der Rechteinhaber hat die Einbettung für dieses Video abgeschaltet. Das ist eine Vorgabe des Anbieters und lässt sich nicht durch Konfiguration beheben.";
        } else if (status && status !== "OK") {
          result.verdict = `YouTube meldet playabilityStatus=${status}${reason ? ` (${reason})` : ""}.`;
        } else if (playableInEmbed === "true") {
          result.verdict = "YouTube erlaubt die Einbettung. Scheitert sie trotzdem, liegt es an der Seite selbst – siehe Origin/HTTPS unten.";
        }
      } catch (err) {
        findings.push({ check: "Embed-Seite", status: 0, detail: `Nicht erreichbar: ${err.message}` });
      }
    } else if (channelId) {
      try {
        const page = await fetchText(`https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channelId)}`);
        const status = /"playabilityStatus":\{"status":"([A-Z_]+)"/.exec(page.text)?.[1];
        const hasPlayer = /"videoId":"([\w-]{11})"/.exec(page.text)?.[1];
        findings.push({
          check: "Kanal-Livestream-Einbettung (/embed/live_stream)",
          status: page.status,
          detail: [
            hasPlayer ? `aufgelöste Video-ID: ${hasPlayer}` : "keine Video-ID in der Antwort",
            status ? `playabilityStatus=${status}` : null,
          ].filter(Boolean).join(", "),
        });
        result.verdict = hasPlayer
          ? `Der Kanal-Link löst derzeit auf das Video ${hasPlayer} auf.`
          : "Dieser Kanal-Link löst derzeit auf keinen Livestream auf. /embed/live_stream ist ein altes YouTube-Verfahren, das nur funktioniert, solange YouTube es für den Kanal beantwortet – es gibt keine Garantie. Zuverlässig ist der direkte Video-Link des laufenden Streams.";
      } catch (err) {
        findings.push({ check: "Kanal-Livestream-Einbettung", status: 0, detail: `Nicht erreichbar: ${err.message}` });
      }
    }
    return result;
  }

  if (host === "twitch.tv" || host === "player.twitch.tv") {
    result.kind = "twitch";
    const channel = u.searchParams.get("channel") || u.pathname.split("/").filter(Boolean)[0];
    findings.push({
      check: "Voraussetzungen der Twitch-Einbettung",
      status: 200,
      detail: "Twitch-Embeds brauchen (1) eine Seite über HTTPS, (2) einen echten Hostnamen und (3) genau diesen Hostnamen im parent-Parameter. Eine reine IP-Adresse oder http:// wird abgelehnt.",
    });
    if (channel) {
      try {
        const page = await fetchText(`https://www.twitch.tv/${encodeURIComponent(channel)}`, { limit: 150_000 });
        findings.push({
          check: "Kanalseite erreichbar",
          status: page.status,
          detail: page.ok ? `Kanal ${channel} antwortet.` : `Kanal ${channel} antwortet mit ${page.status}.`,
        });
      } catch (err) {
        findings.push({ check: "Kanalseite erreichbar", status: 0, detail: `Nicht erreichbar: ${err.message}` });
      }
    }
    result.verdict = "Ob der Kanal gerade live ist, lässt sich ohne Twitch-API-Zugang (Helix, eigene Client-ID) nicht feststellen. Diese Anwendung fragt die Twitch-API nicht ab.";
    return result;
  }

  return { error: "Diagnose gibt es nur für YouTube- und Twitch-Links" };
}

// ---------- Weiterleitung an den Browser-Container ----------

const starts = new Map(); // IP -> { count, resetAt }

/**
 * Adresse des Zuschauers. Ohne TRUST_PROXY die des direkten Gegenübers; das ist
 * hinter Caddy/Nginx der Proxy selbst, das Limit wirkt dann für alle gemeinsam.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    // Die letzte Angabe stammt vom nächstgelegenen – also unserem – Proxy.
    const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return String(req.socket.remoteAddress || "unbekannt");
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = starts.get(ip);
  if (!entry || now > entry.resetAt) {
    starts.set(ip, { count: 1, resetAt: now + 60_000 });
    if (starts.size > 5000) starts.clear();
    return false;
  }
  entry.count++;
  return entry.count > BROWSER_STARTS_PER_MINUTE;
}

/**
 * Anfrage an den Browser-Dienst weiterreichen. Body und Antwort werden
 * unverändert durchgeleitet, damit SDP (WHEP) genauso funktioniert wie JSON.
 */
function proxyToBrowserService(req, res, { pathname, body, sessionToken }) {
  const target = new URL(pathname, BROWSER_SERVICE_URL);
  const payload = Buffer.from(body ?? "");
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname,
      method: "POST",
      timeout: 20_000,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "Content-Length": payload.length,
        "X-Service-Token": BROWSER_SERVICE_TOKEN,
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        "Content-Type": up.headers["content-type"] || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      up.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("Zeitüberschreitung")));
  upstream.on("error", (err) =>
    send(res, 502, { error: `Browser-Dienst nicht erreichbar: ${err.message}` }),
  );
  upstream.end(payload);
}

async function handleBrowserApi(req, res, url) {
  if (!BROWSER_PLAYBACK) return send(res, 404, { error: "Browser-Wiedergabe ist nicht eingeschaltet" });

  if (url.pathname === "/api/browser/config" && req.method === "GET") {
    return send(res, 200, { enabled: true, requiresPassword: Boolean(BROWSER_VIEWER_PASSWORD) });
  }

  if (url.pathname === "/api/browser/sessions" && req.method === "POST") {
    if (BROWSER_VIEWER_PASSWORD && !headerMatches(req, "x-browser-password", BROWSER_VIEWER_PASSWORD)) {
      return send(res, 401, { error: "Passwort für die Browser-Wiedergabe erforderlich" });
    }
    if (rateLimited(req)) return send(res, 429, { error: "Zu viele Startversuche. Bitte kurz warten." });

    let streamId;
    try {
      streamId = String(JSON.parse(await readBody(req, 2000)).streamId || "");
    } catch {
      return send(res, 400, { error: "Ungültige Anfrage" });
    }
    // Die Ziel-URL kommt ausschließlich aus der gespeicherten Liste. Zuschauer
    // können keine beliebige Adresse öffnen lassen.
    const stream = readStreams().find((s) => s.id === streamId);
    if (!stream) return send(res, 404, { error: "Stream unbekannt" });
    if (stream.mode !== "browser") {
      return send(res, 400, { error: "Für diesen Stream ist die Browser-Wiedergabe nicht eingeschaltet" });
    }
    return proxyToBrowserService(req, res, {
      pathname: "/sessions",
      body: JSON.stringify({ url: stream.url }),
    });
  }

  const m = /^\/api\/browser\/sessions\/([a-z0-9]{1,32})\/(whep|keepalive|close)$/.exec(url.pathname);
  if (m && req.method === "POST") {
    const [, id, action] = m;
    const sessionToken = String(req.headers["x-session-token"] || "").slice(0, 128);
    if (!/^[a-f0-9]{8,128}$/.test(sessionToken)) return send(res, 401, { error: "Sitzungs-Token fehlt" });
    let body;
    try {
      body = await readBody(req, 256_000);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    return proxyToBrowserService(req, res, { pathname: `/sessions/${id}/${action}`, body, sessionToken });
  }

  return send(res, 404, { error: "Unbekannter Pfad" });
}

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/browser/")) return handleBrowserApi(req, res, url);

  if (url.pathname === "/api/streams") {
    if (req.method === "GET") return send(res, 200, readStreams());
    if (req.method === "PUT") {
      try {
        const list = sanitize(JSON.parse(await readBody(req)));
        writeStreams(list);
        return send(res, 200, list);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    return send(res, 405, { error: "Methode nicht erlaubt" });
  }

  // YouTube-@Handles lassen sich nicht direkt einbetten – hier in eine Kanal-ID übersetzen.
  // Der Server holt dafür eine fremde Seite ab; angenommen werden nur youtube.com/@name-Links.
  if (url.pathname === "/api/resolve") {
    const m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[\w.\-]{1,100})/i.exec(url.searchParams.get("url") || "");
    if (!m) return send(res, 400, { error: "Nur youtube.com/@name-Links werden aufgelöst" });
    try {
      const r = await fetchText(`https://www.youtube.com/${m[1]}`);
      const id =
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(r.text)?.[1] ||
        /"externalId":"(UC[\w-]{22})"/.exec(r.text)?.[1];
      if (!id) return send(res, 404, { error: `Kanal ${m[1]} nicht gefunden – bitte Video- oder /channel/UC…-Link verwenden` });
      return send(res, 200, { channelId: id });
    } catch {
      return send(res, 502, { error: "YouTube nicht erreichbar – bitte Video- oder /channel/UC…-Link verwenden" });
    }
  }

  // Diagnose: warum läuft ein Link in der Einbettung nicht?
  if (url.pathname === "/api/diagnose") {
    try {
      const report = await diagnose(url.searchParams.get("url") || "");
      return send(res, report.error ? 400 : 200, report);
    } catch (err) {
      return send(res, 502, { error: `Diagnose fehlgeschlagen: ${err.message}` });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Methode nicht erlaubt" });

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden", "text/plain");

  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Backyard Streams läuft auf http://${HOST}:${PORT}`);
    console.log("Hinweis: Die Stream-Liste ist ohne Passwort änderbar.");
    if (BROWSER_PLAYBACK) {
      console.log(`Browser-Wiedergabe ist eingeschaltet (Dienst: ${BROWSER_SERVICE_URL}).`);
      if (!BROWSER_SERVICE_TOKEN) {
        console.error("FEHLER: BROWSER_SERVICE_TOKEN fehlt – die Browser-Wiedergabe wird nicht funktionieren.");
      }
      if (!BROWSER_VIEWER_PASSWORD) {
        console.log(
          "Hinweis: BROWSER_VIEWER_PASSWORD ist nicht gesetzt – jeder Besucher der Seite kann Browser-Sitzungen starten (im Rahmen der Limits).",
        );
      }
    }
  });
}

module.exports = { server, sanitize, diagnose };
