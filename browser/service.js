// Browser-Wiedergabe: Steuerdienst im Browser-Container.
//
// Verwaltet die Aufnahme-Sitzungen, begrenzt Anzahl und Laufzeit und reicht die
// WHEP-Aushandlung an den lokalen Media-Server weiter. Der Dienst ist nur über
// das interne Docker-Netz erreichbar und verlangt zusätzlich ein gemeinsames
// Geheimnis (BROWSER_SERVICE_TOKEN), das nur die Hauptanwendung kennt.

"use strict";

const http = require("http");
const crypto = require("crypto");
const { Session, killGroup } = require("./lib/session");
const { createEgressProxy } = require("./lib/egress-proxy");
const { expandAllowList, checkTargetUrl } = require("./lib/guard");

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const bool = (value, fallback = false) =>
  value === undefined || value === "" ? fallback : /^(1|true|yes|on)$/i.test(String(value));

const cfg = {
  port: num(process.env.BROWSER_SERVICE_PORT, 8090),
  host: process.env.BROWSER_SERVICE_HOST || "0.0.0.0",
  serviceToken: process.env.BROWSER_SERVICE_TOKEN || "",
  rtspPort: num(process.env.BROWSER_RTSP_PORT, 8554),
  webrtcPort: num(process.env.BROWSER_WEBRTC_PORT, 8889),
  egressPort: num(process.env.BROWSER_EGRESS_PORT, 8081),
  chromiumPath: process.env.BROWSER_CHROMIUM_PATH || "/usr/bin/chromium",
  maxSessions: num(process.env.BROWSER_MAX_SESSIONS, 2),
  width: num(process.env.BROWSER_WIDTH, 1280),
  height: num(process.env.BROWSER_HEIGHT, 720),
  fps: num(process.env.BROWSER_FPS, 25),
  videoBitrate: process.env.BROWSER_VIDEO_BITRATE || "2500k",
  videoBufsize: process.env.BROWSER_VIDEO_BUFSIZE || "1250k",
  audioBitrate: process.env.BROWSER_AUDIO_BITRATE || "96k",
  preset: process.env.BROWSER_X264_PRESET || "ultrafast",
  // h264 = weniger CPU, alle offiziellen Browser. vp8 = läuft auch in
  // Chromium-Bauten ohne proprietäre Codecs, kostet dafür mehr CPU.
  videoCodec: /^vp8$/i.test(String(process.env.BROWSER_VIDEO_CODEC || "")) ? "vp8" : "h264",
  idleTimeoutMs: num(process.env.BROWSER_IDLE_TIMEOUT, 90) * 1000,
  maxSessionMs: num(process.env.BROWSER_MAX_SESSION_SECONDS, 4 * 3600) * 1000,
  browserWarmupMs: num(process.env.BROWSER_WARMUP_MS, 4000),
  publishWarmupMs: num(process.env.BROWSER_PUBLISH_WARMUP_MS, 2500),
  lang: process.env.BROWSER_LANG || "de-DE",
  noSandbox: bool(process.env.BROWSER_CHROMIUM_NO_SANDBOX, false),
  disableDevShm: bool(process.env.BROWSER_DISABLE_DEV_SHM, false),
  extraChromiumArgs: (process.env.BROWSER_CHROMIUM_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
  displayBase: num(process.env.BROWSER_DISPLAY_BASE, 101),
};
// Alles durch den Egress-Proxy, loopback ausdrücklich eingeschlossen.
cfg.proxyArgs = [`--proxy-server=http://127.0.0.1:${cfg.egressPort}`, "--proxy-bypass-list=<-loopback>"];

const allowList = expandAllowList(
  [...(process.env.BROWSER_ALLOWED_PRESETS || "").split(","), ...(process.env.BROWSER_ALLOWED_HOSTS || "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean),
);

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

if (!cfg.serviceToken) {
  console.error("BROWSER_SERVICE_TOKEN ist nicht gesetzt – der Dienst würde ohne Authentifizierung laufen. Abbruch.");
  process.exit(1);
}
if (!allowList.length) {
  log("Hinweis: keine freigegebenen Hosts (BROWSER_ALLOWED_HOSTS/PRESETS) – es kann keine Sitzung starten.");
}
log(`Freigegebene Hosts: ${allowList.join(", ") || "(keine)"}`);

// ---------- Sitzungsverwaltung ----------

/** @type {Map<string, {session: Session, token: string}>} */
const sessions = new Map();
const usedDisplays = new Set();

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function takeDisplay() {
  for (let i = 0; i < cfg.maxSessions + 2; i++) {
    const d = cfg.displayBase + i;
    if (!usedDisplays.has(d)) {
      usedDisplays.add(d);
      return d;
    }
  }
  throw new Error("kein freies Display");
}

async function removeSession(id, reason) {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  log(`[${id}] wird beendet (${reason})`);
  usedDisplays.delete(entry.session.display);
  await entry.session.stop();
}

async function startSession(rawUrl) {
  const check = checkTargetUrl(rawUrl, allowList);
  if (!check.ok) return { error: check.reason, status: 403 };

  // Gleiche Seite, laufende Sitzung: wiederverwenden statt neu starten.
  for (const [id, entry] of sessions) {
    if (entry.session.url === check.url.href && entry.session.state !== "failed") {
      entry.session.touch();
      return { id, token: entry.token, session: entry.session };
    }
  }
  if (sessions.size >= cfg.maxSessions) {
    return { error: `Es laufen schon ${cfg.maxSessions} Browser-Sitzungen. Bitte später erneut versuchen.`, status: 503 };
  }

  const id = "s" + crypto.randomBytes(6).toString("hex");
  const token = crypto.randomBytes(24).toString("hex");
  let display;
  try {
    display = takeDisplay();
  } catch (err) {
    return { error: err.message, status: 503 };
  }

  const session = new Session({ id, url: check.url.href, display, config: cfg, log });
  sessions.set(id, { session, token });
  log(`[${id}] startet: ${session.url} (Display :${display})`);
  try {
    await session.start();
  } catch (err) {
    await removeSession(id, `Start fehlgeschlagen: ${err.message}`);
    return { error: `Browser-Sitzung konnte nicht starten: ${err.message}`, status: 500 };
  }
  if (session.state === "failed") {
    const reason = session.error;
    await removeSession(id, reason);
    return { error: `Browser-Sitzung konnte nicht starten: ${reason}`, status: 500 };
  }
  return { id, token, session };
}

// Leerlauf und Höchstlaufzeit überwachen.
setInterval(() => {
  const now = Date.now();
  for (const [id, { session }] of sessions) {
    if (session.state === "failed") removeSession(id, `Prozessfehler: ${session.error}`);
    else if (now - session.lastSeenAt > cfg.idleTimeoutMs) removeSession(id, "Leerlauf");
    else if (now - session.startedAt > cfg.maxSessionMs) removeSession(id, "Höchstlaufzeit erreicht");
  }
}, 10_000).unref();

// ---------- WHEP an den Media-Server weiterreichen ----------

function proxyWhep(id, req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    if (aborted) return;
    size += c.length;
    if (size > 256_000) {
      aborted = true;
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: cfg.webrtcPort,
        method: "POST",
        path: `/${encodeURIComponent(id)}/whep`,
        headers: { "Content-Type": "application/sdp", "Content-Length": body.length },
      },
      (up) => {
        const headers = { "Content-Type": up.headers["content-type"] || "application/sdp", "Cache-Control": "no-store" };
        res.writeHead(up.statusCode || 502, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => sendJson(res, 502, { error: `Media-Server nicht erreichbar: ${err.message}` }));
    upstream.end(body);
  });
}

// ---------- HTTP-API ----------

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("Body zu groß"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Ungültiges JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Sitzung anhand von Pfad-Id und mitgeschicktem Sitzungs-Token. */
function authorizeSession(req, id) {
  const entry = sessions.get(id);
  if (!entry) return null;
  const header = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = header || String(req.headers["x-session-token"] || "");
  return timingSafeEqual(token, entry.token) ? entry : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://service");
  const path = url.pathname;

  if (path === "/health" && req.method === "GET") {
    // Für den Docker-Healthcheck reicht ok. Einzelheiten – darunter die
    // Hostfreigabe – nur mit dem Dienst-Token.
    if (!timingSafeEqual(req.headers["x-service-token"], cfg.serviceToken)) {
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, {
      ok: true,
      sessions: [...sessions.values()].map((e) => e.session.info()),
      maxSessions: cfg.maxSessions,
      videoCodec: cfg.videoCodec,
      allowedHosts: allowList,
      blockedHosts: egress.blockedHosts(),
    });
  }

  // Alles andere nur für die Hauptanwendung.
  if (!timingSafeEqual(req.headers["x-service-token"], cfg.serviceToken)) {
    return sendJson(res, 401, { error: "Nicht autorisiert" });
  }

  if (path === "/sessions" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const result = await startSession(body.url);
    if (result.error) return sendJson(res, result.status || 400, { error: result.error });
    return sendJson(res, 201, {
      id: result.id,
      token: result.token,
      state: result.session.state,
      width: result.session.width,
      height: result.session.height,
      fps: result.session.fps,
      idleTimeoutSeconds: Math.round(cfg.idleTimeoutMs / 1000),
    });
  }

  const m = /^\/sessions\/([a-z0-9]{1,32})\/(whep|keepalive|close)$/.exec(path);
  if (m && req.method === "POST") {
    const [, id, action] = m;
    const entry = authorizeSession(req, id);
    if (!entry) return sendJson(res, 404, { error: "Sitzung unbekannt oder Token falsch" });
    entry.session.touch();
    if (action === "keepalive") return sendJson(res, 200, entry.session.info());
    if (action === "close") {
      await removeSession(id, "vom Client beendet");
      return sendJson(res, 200, { ok: true });
    }
    if (entry.session.state === "failed") {
      return sendJson(res, 503, { error: entry.session.error || "Sitzung fehlgeschlagen" });
    }
    return proxyWhep(id, req, res);
  }

  return sendJson(res, 404, { error: "Unbekannter Pfad" });
});

// ---------- Start / Stop ----------

const egress = createEgressProxy({ allowList: () => allowList, log });

(async () => {
  await egress.listen(cfg.egressPort, "127.0.0.1");
  log(`Egress-Proxy auf 127.0.0.1:${cfg.egressPort}`);
  server.listen(cfg.port, cfg.host, () =>
    log(`Steuerdienst auf ${cfg.host}:${cfg.port} (max. ${cfg.maxSessions} Sitzungen, ` +
      `${cfg.width}x${cfg.height}@${cfg.fps}, Video ${cfg.videoCodec})`),
  );
})();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} – alle Sitzungen werden beendet`);
  server.close();
  await Promise.all([...sessions.keys()].map((id) => removeSession(id, "Dienst wird beendet")));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Letzte Rettung: beim Beenden ohne Signalbehandlung trotzdem die Gruppen töten.
process.on("exit", () => {
  for (const { session } of sessions.values()) {
    for (const child of Object.values(session.children)) killGroup(child, "SIGKILL");
  }
});

module.exports = { cfg, allowList };
