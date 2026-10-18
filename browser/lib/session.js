// Eine Aufnahme-Sitzung: X-Display, Audio-Senke, Chromium, ffmpeg.
//
// Jede Sitzung bekommt eigene Prozesse und ein eigenes Browserprofil. Die
// Kindprozesse laufen in einer eigenen Prozessgruppe (detached), damit sie sich
// samt aller Chromium-Unterprozesse mit einem Signal beenden lassen.

"use strict";

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const GRACE_MS = 4000; // bis SIGKILL
const FFMPEG_MAX_RESTARTS = 3;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Prozessgruppe beenden und nicht am Fehler hängen bleiben, wenn sie schon weg ist. */
function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* schon beendet */
    }
  }
}

class Session {
  /**
   * @param {object} opts
   * @param {string} opts.id         Pfadname auf dem Media-Server
   * @param {string} opts.url        Zielseite (bereits geprüft)
   * @param {number} opts.display    X-Display-Nummer
   * @param {object} opts.config     Limits und Pfade
   * @param {(line: string) => void} opts.log
   */
  constructor({ id, url, display, config, log }) {
    this.id = id;
    this.url = url;
    this.display = display;
    this.config = config;
    this.log = log;
    this.state = "starting";
    this.error = null;
    this.startedAt = Date.now();
    this.lastSeenAt = Date.now();
    this.children = {};
    this.sinkName = `bys_${id}`;
    this.sinkModuleId = null;
    this.ffmpegRestarts = 0;
    this.stopping = false;
    this.profileDir = null;

    this.width = clamp(config.width, 320, 1920, 1280);
    this.height = clamp(config.height, 240, 1080, 720);
    this.fps = clamp(config.fps, 5, 30, 25);
  }

  get rtspUrl() {
    return `rtsp://127.0.0.1:${this.config.rtspPort}/${this.id}`;
  }

  async start() {
    this.profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), `bys-profile-${this.id}-`));
    await this.startXvfb();
    await this.loadAudioSink();
    this.startChromium();
    await new Promise((r) => setTimeout(r, this.config.browserWarmupMs));
    this.startFfmpeg();
    await new Promise((r) => setTimeout(r, this.config.publishWarmupMs));
    if (this.state === "starting") this.state = "running";
    return this;
  }

  spawnChild(name, cmd, args, env = {}) {
    const child = spawn(cmd, args, {
      detached: true, // eigene Prozessgruppe -> sauberes Aufräumen
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.children[name] = child;
    const tail = [];
    const collect = (buf) => {
      tail.push(String(buf));
      if (tail.length > 20) tail.shift();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.lastOutput = () => tail.join("").trim().split("\n").slice(-4).join(" | ");
    child.on("error", (err) => this.fail(`${name} konnte nicht starten: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (this.stopping) return;
      if (name === "ffmpeg" && this.ffmpegRestarts < FFMPEG_MAX_RESTARTS) {
        this.ffmpegRestarts++;
        this.log(`[${this.id}] ffmpeg beendet (${code ?? signal}) – Neustart ${this.ffmpegRestarts}`);
        setTimeout(() => !this.stopping && this.startFfmpeg(), 500);
        return;
      }
      this.fail(`${name} beendet (${code ?? signal}): ${child.lastOutput()}`);
    });
    return child;
  }

  fail(message) {
    if (this.stopping || this.state === "failed") return;
    this.state = "failed";
    this.error = message;
    this.log(`[${this.id}] Fehler: ${message}`);
  }

  async startXvfb() {
    // Nur Software-Rendering, kein TCP-Listener auf dem X-Server.
    this.spawnChild("xvfb", "Xvfb", [
      `:${this.display}`,
      "-screen", `0`, `${this.width}x${this.height}x24`,
      "-nolisten", "tcp",
      "-noreset",
      "-dpi", "96",
    ]);
    await this.waitForDisplay();
  }

  waitForDisplay() {
    const deadline = Date.now() + 10_000;
    const socket = `/tmp/.X11-unix/X${this.display}`;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (fs.existsSync(socket)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`Xvfb :${this.display} startet nicht`));
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  /** Eigene Null-Senke pro Sitzung: der Ton bleibt zwischen Sitzungen getrennt. */
  loadAudioSink() {
    return new Promise((resolve, reject) => {
      execFile(
        "pactl",
        ["load-module", "module-null-sink", `sink_name=${this.sinkName}`, "channels=2", "rate=48000",
          `sink_properties=device.description=${this.sinkName}`],
        { timeout: 10_000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`Audio-Senke fehlgeschlagen: ${stderr || err.message}`));
          this.sinkModuleId = String(stdout).trim();
          resolve();
        },
      );
    });
  }

  startChromium() {
    const c = this.config;
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--noerrdialogs",
      "--disable-sync", "--disable-extensions", "--disable-background-mode",
      "--disable-component-update", "--disable-breakpad", "--disable-crash-reporter",
      "--password-store=basic", "--use-mock-keychain",
      "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      "--kiosk",
      `--window-size=${this.width},${this.height}`,
      "--window-position=0,0",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      // Kein Nutzer kann klicken – ohne das bleibt jedes Video stehen.
      "--autoplay-policy=no-user-gesture-required",
      // Software-Rendering: der Server hat keine GPU.
      "--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      `--lang=${c.lang}`,
      // Jede HTTP(S)-Anfrage durch den Egress-Proxy, loopback ausdrücklich mit.
      // Der Dienst setzt das; nur der Smoke-Test lässt es für eine lokale
      // Testquelle weg.
      ...(c.proxyArgs || []),
    ];
    if (c.noSandbox) args.push("--no-sandbox"); // nur als Notausgang, siehe Doku
    if (c.disableDevShm) args.push("--disable-dev-shm-usage");
    if (c.extraChromiumArgs.length) args.push(...c.extraChromiumArgs);
    args.push(this.url);

    this.spawnChild("chromium", c.chromiumPath, args, {
      DISPLAY: `:${this.display}`,
      PULSE_SINK: this.sinkName,
      // Kein eigener User-Agent, kein Verstecken der Automatisierung:
      // der Browser gibt sich als das aus, was er ist.
    });
  }

  /**
   * Video-Argumente für ffmpeg.
   *
   * H.264 kostet deutlich weniger CPU und können alle offiziellen Browser
   * abspielen. VP8 ist in WebRTC zwingend vorgeschrieben und funktioniert daher
   * auch in Chromium-Bauten ohne proprietäre Codecs (viele Linux-Distributionen)
   * – zahlt das aber mit mehr CPU-Last.
   */
  videoArgs() {
    const c = this.config;
    const common = ["-pix_fmt", "yuv420p", "-g", String(this.fps * 2),
      "-b:v", c.videoBitrate, "-maxrate", c.videoBitrate, "-bufsize", c.videoBufsize];
    if (c.videoCodec === "vp8") {
      return ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
        "-auto-alt-ref", "0", "-lag-in-frames", "0", "-error-resilient", "1", ...common];
    }
    return ["-c:v", "libx264", "-preset", c.preset, "-tune", "zerolatency",
      "-profile:v", "baseline", ...common];
  }

  startFfmpeg() {
    const c = this.config;
    const args = [
      "-nostdin", "-loglevel", "warning",
      "-f", "x11grab", "-draw_mouse", "0", "-thread_queue_size", "256",
      "-framerate", String(this.fps), "-video_size", `${this.width}x${this.height}`,
      "-i", `:${this.display}.0`,
      "-f", "pulse", "-thread_queue_size", "256", "-i", `${this.sinkName}.monitor`,
      ...this.videoArgs(),
      "-c:a", "libopus", "-b:a", c.audioBitrate, "-ac", "2", "-ar", "48000",
      "-f", "rtsp", "-rtsp_transport", "tcp", this.rtspUrl,
    ];
    this.spawnChild("ffmpeg", "ffmpeg", args, { DISPLAY: `:${this.display}` });
  }

  touch() {
    this.lastSeenAt = Date.now();
  }

  info() {
    return {
      id: this.id,
      url: this.url,
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      width: this.width,
      height: this.height,
      fps: this.fps,
    };
  }

  /** Alles beenden: Prozessgruppen, Audio-Senke, Profilverzeichnis. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.state = "stopped";

    for (const child of Object.values(this.children)) killGroup(child, "SIGTERM");
    await new Promise((r) => setTimeout(r, GRACE_MS));
    for (const child of Object.values(this.children)) killGroup(child, "SIGKILL");

    if (this.sinkModuleId) {
      await new Promise((resolve) =>
        execFile("pactl", ["unload-module", this.sinkModuleId], { timeout: 5000 }, () => resolve()),
      );
    }
    if (this.profileDir) {
      await fsp.rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
    }
    this.log(`[${this.id}] beendet`);
  }
}

module.exports = { Session, killGroup, clamp };
