#!/usr/bin/env node
// Rauchtest der Browser-Wiedergabe: fährt die echte Aufnahmekette gegen die
// mitgelieferte eigene Testquelle hoch und prüft messbar, ob Bild UND Ton
// ankommen – und ob danach wirklich alle Prozesse weg sind.
//
//   node scripts/smoke-browser-playback.js
//
// Voraussetzungen auf dem Rechner: Xvfb, chromium, ffmpeg/ffprobe, pulseaudio,
// mediamtx. Im Browser-Container sind alle vorhanden; lokal lassen sich die
// Pfade über Umgebungsvariablen setzen:
//   BROWSER_CHROMIUM_PATH, MEDIAMTX_BIN
//
// Die Testquelle wird über 127.0.0.1 ausgeliefert. Deshalb läuft dieser Test
// ohne den Egress-Proxy: der würde loopback – richtigerweise – blockieren.

"use strict";

const { spawn, execFileSync, execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { Session } = require("../browser/lib/session");

const ROOT = path.join(__dirname, "..");
const CHROMIUM = process.env.BROWSER_CHROMIUM_PATH || "/usr/bin/chromium";
const CODEC = /^vp8$/i.test(String(process.env.BROWSER_VIDEO_CODEC || "")) ? "vp8" : "h264";
const MEDIAMTX = process.env.MEDIAMTX_BIN || "mediamtx";
const RECORD_SECONDS = 5;

const log = (...a) => console.log("•", ...a);
const fail = (msg) => {
  console.error("\n✗ " + msg);
  process.exitCode = 1;
  throw new Error(msg);
};

function have(cmd) {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Seite für den Zuschauer-Test: benutzt denselben WHEP-Client wie das Frontend.
const VIEWER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WHEP-Test</title></head>
<body><video id="v" autoplay muted playsinline></video>
<script src="/whep.js"></script>
<script>
(async () => {
  const report = (r) => fetch("/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
  try {
    const video = document.getElementById("v");
    const pc = await window.BackyardWhep.connect({ whepUrl: "/whep", video, attempts: 8 });
    // Warten, bis wirklich Daten fließen – eine Aushandlung allein beweist nichts.
    let stats = { audioBytes: 0, videoBytes: 0 };
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      stats = { audioBytes: 0, videoBytes: 0 };
      (await pc.getStats()).forEach((s) => {
        if (s.type !== "inbound-rtp") return;
        if (s.kind === "audio") stats.audioBytes = s.bytesReceived || 0;
        if (s.kind === "video") stats.videoBytes = s.bytesReceived || 0;
      });
      if (stats.audioBytes > 20000 && stats.videoBytes > 60000 && video.videoWidth > 0) break;
    }
    await report({
      ok: true, connectionState: pc.connectionState, ...stats,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      tracks: pc.getReceivers().map((r) => r.track && r.track.kind).filter(Boolean),
      viewerCodecs: RTCRtpReceiver.getCapabilities("video").codecs.map((c) => c.mimeType),
    });
  } catch (err) {
    await report({ ok: false, error: String(err && err.message || err) });
  }
})();
</script></body></html>`;

/**
 * Liefert die eigene Testquelle, die Zuschauer-Testseite und whep.js aus und
 * reicht WHEP an den Media-Server weiter – genau wie server.js in Betrieb.
 */
async function serveTestSource(webrtcPort, sessionId) {
  const port = await freePort();
  let resolveResult;
  const result = new Promise((r) => { resolveResult = r; });

  const server = http.createServer((req, res) => {
    if (req.url === "/viewer.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(VIEWER_PAGE);
    }
    if (req.url === "/result" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(204).end();
        try {
          resolveResult(JSON.parse(body));
        } catch {
          resolveResult({ ok: false, error: "unlesbares Ergebnis" });
        }
      });
      return;
    }
    if (req.url === "/whep" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const offer = Buffer.concat(chunks);
        const up = http.request({
          host: "127.0.0.1", port: webrtcPort, method: "POST",
          path: `/${sessionId}/whep`,
          headers: { "Content-Type": "application/sdp", "Content-Length": offer.length },
        }, (upRes) => {
          res.writeHead(upRes.statusCode || 502, { "Content-Type": upRes.headers["content-type"] || "application/sdp" });
          upRes.pipe(res);
        });
        up.on("error", () => res.writeHead(502).end());
        up.end(offer);
      });
      return;
    }
    const file = path.join(ROOT, "public", req.url === "/" ? "browser-test-source.html" : req.url.slice(1).split("?")[0]);
    if (!file.startsWith(path.join(ROOT, "public"))) return res.writeHead(403).end();
    fs.readFile(file, (err, body) => {
      if (err) return res.writeHead(404).end();
      const type = file.endsWith(".html") ? "text/html; charset=utf-8"
        : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}/browser-test-source.html`,
    viewerUrl: `http://127.0.0.1:${port}/viewer.html`,
    result,
    close: () => server.close(),
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function main() {
  const missing = ["Xvfb", "ffmpeg", "ffprobe", "pulseaudio", "pactl"].filter((c) => !have(c));
  if (!fs.existsSync(CHROMIUM)) missing.push(`chromium (${CHROMIUM})`);
  if (!have(MEDIAMTX) && !fs.existsSync(MEDIAMTX)) missing.push(`mediamtx (${MEDIAMTX})`);
  if (missing.length) {
    console.log(`übersprungen – nicht installiert: ${missing.join(", ")}`);
    console.log("Im Browser-Container ist alles vorhanden: docker compose --profile browser run --rm --entrypoint sh backyard-browser");
    return;
  }

  const runtime = await fsp.mkdtemp(path.join(os.tmpdir(), "bys-smoke-"));
  const rtspPort = await freePort();
  const webrtcPort = await freePort();
  const pulseSocket = path.join(runtime, "pulse.sock");
  const started = [];
  const stop = (child) => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch { /* schon weg */ }
    }
  };

  let source;
  let session;
  try {
    // --- PulseAudio -------------------------------------------------------
    const pulseEnv = { ...process.env, XDG_RUNTIME_DIR: runtime };
    delete pulseEnv.PULSE_SERVER; // sonst verweigert PulseAudio den Start
    const pulse = spawn("pulseaudio", [
      "-n", "--daemonize=no", "--exit-idle-time=-1", "--disallow-exit",
      `--load=module-native-protocol-unix socket=${pulseSocket} auth-anonymous=1`,
      "--log-target=newfile:" + path.join(runtime, "pulse.log"), "--log-level=warn",
    ], { detached: true, stdio: "ignore", env: pulseEnv });
    started.push(pulse);
    process.env.PULSE_SERVER = `unix:${pulseSocket}`;
    process.env.XDG_RUNTIME_DIR = runtime;
    for (let i = 0; i < 50 && !fs.existsSync(pulseSocket); i++) await new Promise((r) => setTimeout(r, 200));
    if ((await run("pactl", ["info"])).err) fail("PulseAudio ist nicht erreichbar");
    log("PulseAudio läuft");

    // --- MediaMTX ---------------------------------------------------------
    const cfgFile = path.join(runtime, "mediamtx.yml");
    await fsp.writeFile(cfgFile, [
      "logLevel: error", "api: false", "metrics: false", "pprof: false", "playback: false",
      "rtmp: false", "srt: false", "hls: false", "moq: false",
      "rtsp: true", `rtspAddress: 127.0.0.1:${rtspPort}`, "rtspTransports: [tcp]",
      "webrtc: true", `webrtcAddress: 127.0.0.1:${webrtcPort}`,
      "webrtcLocalUDPAddress: 127.0.0.1:0", 'webrtcLocalTCPAddress: ""',
      "webrtcIPsFromInterfaces: false", 'webrtcAdditionalHosts: ["127.0.0.1"]',
      "paths:", "  all_others:", "",
    ].join("\n"));
    const mtx = spawn(MEDIAMTX, [cfgFile], { detached: true, stdio: "ignore" });
    started.push(mtx);
    await new Promise((r) => setTimeout(r, 1500));
    log("MediaMTX läuft");

    // --- Testquelle -------------------------------------------------------
    source = await serveTestSource(webrtcPort, "smoke");
    log("Testquelle:", source.url);

    // --- Sitzung mit dem echten Sitzungscode ------------------------------
    session = new Session({
      id: "smoke",
      url: source.url,
      display: 97,
      log: (line) => log(line),
      config: {
        rtspPort, webrtcPort, egressPort: 0,
        proxyArgs: [], // bewusst kein Proxy: die Quelle liegt auf 127.0.0.1
        chromiumPath: CHROMIUM,
        width: 1280, height: 720, fps: 25,
        videoBitrate: "2000k", videoBufsize: "1000k", audioBitrate: "96k",
        preset: "ultrafast", lang: "de-DE", videoCodec: CODEC,
        noSandbox: /^(1|true|yes|on)$/i.test(String(process.env.BROWSER_CHROMIUM_NO_SANDBOX || "")),
        disableDevShm: true,
        extraChromiumArgs: [],
        browserWarmupMs: 5000, publishWarmupMs: 3000,
      },
    });
    await session.start();
    if (session.state !== "running") fail(`Sitzung nicht gestartet: ${session.error}`);
    log(`Sitzung läuft (${session.width}x${session.height}@${session.fps}, Video ${CODEC})`);

    // --- Prüfen: liegen Video- und Audiospur am Media-Server an? ----------
    const probe = await run("ffprobe", [
      "-v", "error", "-rtsp_transport", "tcp",
      "-show_entries", "stream=codec_name,codec_type,width,height,channels",
      "-of", "default=nw=1", session.rtspUrl,
    ]);
    if (probe.err) fail(`Stream nicht abrufbar: ${probe.stderr.trim()}`);
    log("Spuren:\n" + probe.stdout.trim().split("\n").map((l) => "    " + l).join("\n"));
    if (!/codec_type=video/.test(probe.stdout)) fail("keine Videospur");
    if (!/codec_type=audio/.test(probe.stdout)) fail("keine Audiospur");

    // --- Inhalt messen ----------------------------------------------------
    const clip = path.join(runtime, "clip.mkv");
    const rec = await run("ffmpeg", [
      "-nostdin", "-v", "error", "-rtsp_transport", "tcp", "-i", session.rtspUrl,
      "-t", String(RECORD_SECONDS), "-c", "copy", "-y", clip,
    ]);
    if (rec.err) fail(`Aufnahme fehlgeschlagen: ${rec.stderr.trim()}`);

    // Bewegung: Szenenwechsel zählen. Ein stehendes Bild ergibt 0.
    const motion = await run("ffmpeg", [
      "-nostdin", "-v", "error", "-i", clip, "-map", "0:v",
      "-vf", "select=gt(scene\\,0.0005),metadata=print:file=-", "-f", "null", "-",
    ]);
    const scenes = (motion.stdout.match(/scene_score/g) || []).length;
    log(`Bewegte Bilder: ${scenes} Szenenwechsel in ${RECORD_SECONDS} s`);
    if (scenes < 5) fail(`Bild bewegt sich nicht (${scenes} Szenenwechsel) – Aufnahme oder Rendering prüfen`);

    // Ton: Spitzenwert und Frequenz. Die Testquelle sendet abwechselnd 440 und
    // 660 Hz. Über eine Datei statt über stdout – binäre Daten durch eine
    // Zeichenkette zu schicken würde sie zerstören.
    const RATE = 8000;
    const pcmFile = path.join(runtime, "audio.s16le");
    const dec = await run("ffmpeg", ["-nostdin", "-v", "error", "-i", clip, "-map", "0:a",
      "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-y", pcmFile]);
    if (dec.err) fail(`Ton nicht dekodierbar: ${dec.stderr.trim()}`);
    const raw = await fsp.readFile(pcmFile);
    const count = Math.floor(raw.length / 2);
    if (count < RATE) fail(`zu wenig Ton aufgenommen (${count} Abtastwerte)`);

    let peak = 0;
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(raw.readInt16LE(i * 2)));
    log(`Ton: Spitzenwert ${peak}`);
    if (peak < 500) fail(`Ton ist still (Spitze ${peak}) – PulseAudio-Senke und PULSE_SINK prüfen`);

    // Goertzel-Filter: wie stark ist 440/660 Hz gegenüber einer Kontrollfrequenz?
    const power = (from, to, freq) => {
      const k = 2 * Math.cos((2 * Math.PI * freq) / RATE);
      let s1 = 0, s2 = 0;
      for (let i = from; i < to; i++) {
        const s0 = raw.readInt16LE(i * 2) + k * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (to - from);
    };
    // In Halbsekundenfenstern prüfen, damit der Wechsel der Tonhöhe nicht stört.
    let matched = 0, windows = 0;
    for (let from = 0; from + RATE / 2 <= count; from += RATE / 2) {
      const to = from + RATE / 2;
      const tone = Math.max(power(from, to, 440), power(from, to, 660));
      const control = power(from, to, 1500); // kommt in der Testquelle nicht vor
      windows++;
      if (tone > 200 && tone > control * 4) matched++;
    }
    log(`Tonhöhe: ${matched} von ${windows} Fenstern zeigen 440 oder 660 Hz`);
    if (matched < Math.ceil(windows * 0.6)) {
      fail("Der aufgenommene Ton passt nicht zur Testquelle (erwartet 440/660 Hz)");
    }

    // --- WebRTC bis zum Zuschauer -----------------------------------------
    // Ein zweiter Chromium spielt den Zuschauer und benutzt denselben
    // WHEP-Client wie das Frontend (public/whep.js).
    log("Zuschauer-Browser startet (WebRTC-Prüfung) …");
    const viewerProfile = path.join(runtime, "viewer-profile");
    const viewerArgs = [
      `--user-data-dir=${viewerProfile}`, "--no-first-run", "--no-default-browser-check",
      "--headless=new", "--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage", "--mute-audio",
    ];
    if (/^(1|true|yes|on)$/i.test(String(process.env.BROWSER_CHROMIUM_NO_SANDBOX || ""))) viewerArgs.push("--no-sandbox");
    viewerArgs.push(source.viewerUrl);
    const viewer = spawn(CHROMIUM, viewerArgs, { detached: true, stdio: "ignore" });
    started.push(viewer);

    const viewerResult = await Promise.race([
      source.result,
      new Promise((r) => setTimeout(() => r({ ok: false, error: "Zeitüberschreitung (60 s)" }), 60_000)),
    ]);
    stop(viewer);
    if (!viewerResult.ok) {
      if (/codecs not supported/i.test(String(viewerResult.error))) {
        fail(`Der Zuschauer-Browser kann ${CODEC.toUpperCase()} nicht abspielen: ${viewerResult.error}\n` +
          "  Viele Chromium-Bauten (u. a. der von Playwright) enthalten kein H.264.\n" +
          "  Mit BROWSER_VIDEO_CODEC=vp8 erneut starten – VP8 ist in WebRTC zwingend vorgeschrieben.\n" +
          "  Für den Betrieb heißt das: H.264 ist sparsamer, VP8 ist verträglicher.");
      }
      fail(`WebRTC-Wiedergabe fehlgeschlagen: ${viewerResult.error}`);
    }
    log(`WebRTC: Zustand ${viewerResult.connectionState}, Spuren ${viewerResult.tracks.join("+")}, ` +
      `${viewerResult.videoWidth}x${viewerResult.videoHeight}, ` +
      `${viewerResult.videoBytes} Byte Video / ${viewerResult.audioBytes} Byte Ton empfangen`);
    if (viewerResult.connectionState !== "connected") fail(`WebRTC-Verbindung nicht hergestellt (${viewerResult.connectionState})`);
    if (!(viewerResult.videoBytes > 20_000)) fail(`zu wenig Video über WebRTC (${viewerResult.videoBytes} Byte)`);
    if (!(viewerResult.audioBytes > 2_000)) fail(`zu wenig Ton über WebRTC (${viewerResult.audioBytes} Byte)`);
    if (!(viewerResult.videoWidth > 0)) fail("der Zuschauer hat kein Bild dekodiert");

    // --- Aufräumen prüfen -------------------------------------------------
    const pids = Object.values(session.children).map((c) => c.pid);
    await session.stop();
    session = null;
    await new Promise((r) => setTimeout(r, 1000));
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length) fail(`nach stop() laufen noch Prozesse: ${alive.join(", ")}`);
    log("Alle Prozesse der Sitzung beendet");

    const sinks = await run("pactl", ["list", "short", "sinks"]);
    if (sinks.stdout.includes("bys_smoke")) fail("Audio-Senke der Sitzung wurde nicht entladen");
    log("Audio-Senke entladen");

    console.log("\n✓ Rauchtest bestanden: Bild und Ton kommen an, Aufräumen funktioniert.");
  } finally {
    if (session) await session.stop().catch(() => {});
    source?.close();
    for (const child of started) stop(child);
    await fsp.rm(runtime, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  if (!process.exitCode) {
    console.error("\n✗ " + err.message);
    process.exitCode = 1;
  }
});
