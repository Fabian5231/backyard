// Backyard Streams – Oberfläche: Streams einbinden und pro Stream stumm/laut schalten.
"use strict";

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");

const state = {
  streams: [],
  tiles: new Map(), // id -> Tile
  browser: { enabled: false, requiresPassword: false },
};

// ---------- kleine Helfer ----------

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem("bys:" + key));
    localStorage.setItem("bys:" + key, JSON.stringify(value));
  } catch {
    return null;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = el("script", { src });
    s.onload = resolve;
    s.onerror = () => reject(new Error("Konnte " + src + " nicht laden"));
    document.head.append(s);
  });
}

/** Wartet auf `promise`, bricht aber nach `ms` mit einer eigenen Meldung ab. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

let ytReady;
function loadYouTubeApi() {
  if (!ytReady) {
    const ready = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    });
    // Ohne das Race bliebe ein Ladefehler des Skripts unbemerkt und die Kachel
    // würde für immer „lädt“ anzeigen.
    ytReady = Promise.race([ready, loadScript("https://www.youtube.com/iframe_api").then(() => ready)]);
  }
  return ytReady;
}

let twitchReady;
function loadTwitchApi() {
  twitchReady ??= loadScript("https://player.twitch.tv/js/embed/v1.js").then(() => {
    if (!window.Twitch?.Player) throw new Error("Twitch-Player-Skript wurde geladen, meldet sich aber nicht");
    return window.Twitch;
  });
  return twitchReady;
}

// ---------- Links erkennen ----------

function parseStreamUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { kind: "invalid" };
  }
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" && parts[0]) return { kind: "youtube", videoId: parts[0] };
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.searchParams.get("v")) return { kind: "youtube", videoId: u.searchParams.get("v") };
    if (["live", "embed", "shorts", "v"].includes(parts[0]) && parts[1] && parts[1] !== "live_stream") {
      return { kind: "youtube", videoId: parts[1] };
    }
    if (parts[0] === "embed" && parts[1] === "live_stream" && u.searchParams.get("channel")) {
      return { kind: "youtube", channelId: u.searchParams.get("channel") };
    }
    if (parts[0] === "channel" && parts[1]) return { kind: "youtube", channelId: parts[1] };
    if (parts[0]?.startsWith("@")) return { kind: "youtube-handle", handle: parts[0] };
  }
  if (host === "twitch.tv" || host === "player.twitch.tv") {
    if (u.searchParams.get("channel")) return { kind: "twitch", channel: u.searchParams.get("channel") };
    if (u.searchParams.get("video")) return { kind: "twitch", video: u.searchParams.get("video") };
    if (parts[0] === "videos" && parts[1]) return { kind: "twitch", video: parts[1] };
    if (parts[0]) return { kind: "twitch", channel: parts[0] };
  }
  return { kind: "iframe", src: u.href };
}

/** Beschriftung für den „beim Anbieter öffnen“-Link einer Kachel. */
function providerLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^(www\.|m\.)/, "");
    if (host.endsWith("youtube.com") || host === "youtu.be") return "Auf YouTube öffnen";
    if (host.endsWith("twitch.tv")) return "Auf Twitch öffnen";
    return "Beim Anbieter öffnen";
  } catch {
    return "Beim Anbieter öffnen";
  }
}

// ---------- Kachel pro Stream ----------

class Tile {
  constructor(stream) {
    this.stream = stream;
    this.muted = true;
    this.volume = store("vol:" + stream.id) ?? 80;
    this.player = null; // { mute(), unmute(), setVolume(0..100) }
    this.cleanups = [];

    this.video = el("div", { class: "video" });
    this.idx = el("span", { class: "idx" });
    this.nameEl = el("span", { class: "name", title: stream.name }, this.idx, stream.name);
    this.muteBtn = el("button", { class: "btn mute", onclick: () => toggle(this) }, "🔇 Stumm");
    this.soloBtn = el("button", { class: "btn small", title: "Nur diesen Stream hören", onclick: () => solo(this) }, "Solo");
    this.vol = el("input", { type: "range", min: "0", max: "100", value: String(this.volume), title: "Lautstärke" });
    this.vol.addEventListener("input", () => {
      this.volume = Number(this.vol.value);
      store("vol:" + this.stream.id, this.volume);
      this.player?.setVolume(this.volume);
    });
    this.bigBtn = el("button", { class: "btn small", title: "Größer/kleiner", onclick: () => this.toggleBig() }, "⤢");

    this.root = el("article", { class: "tile" },
      this.video,
      el("div", { class: "controls" }, this.nameEl, this.muteBtn, this.soloBtn, this.vol, this.bigBtn),
    );
    if (store("big:" + stream.id)) this.root.classList.add("big");
    this.muteBtn.disabled = true;
    this.mount();
  }

  /** Fehler in der Kachel zeigen – immer mit Ausweg zum Anbieter. */
  showError(message, hint) {
    this.player = null;
    this.muteBtn.disabled = true;
    this.root.classList.remove("audible", "loading");
    this.video.replaceChildren(
      el("div", { class: "error" },
        el("p", {}, message),
        hint ? el("p", { class: "hint" }, hint) : "",
        el("a", { class: "btn small", href: this.stream.url, target: "_blank", rel: "noopener noreferrer" },
          providerLabel(this.stream.url)),
      ),
    );
  }

  setStatus(text) {
    this.root.classList.add("loading");
    this.video.replaceChildren(el("div", { class: "status-box" }, text));
  }

  async mount() {
    const info = parseStreamUrl(this.stream.url);
    try {
      if (this.stream.mode === "browser") await this.mountBrowser();
      else if (info.kind === "youtube") await this.mountYouTube(info);
      else if (info.kind === "twitch") await this.mountTwitch(info);
      else if (info.kind === "iframe") this.mountIframe(info.src);
      else throw new Error("Link wird nicht unterstützt: " + this.stream.url);
    } catch (err) {
      // Halbfertige Sitzungen nicht liegen lassen: sonst läuft der Browser auf
      // dem Server weiter, bis das Leerlauf-Timeout greift.
      this.runCleanups();
      this.showError(err.message);
    }
  }

  runCleanups() {
    for (const fn of this.cleanups.reverse()) {
      try {
        fn();
      } catch {
        /* beim Abbauen nicht stolpern */
      }
    }
    this.cleanups = [];
  }

  // ---------- YouTube ----------

  async mountYouTube({ videoId, channelId }) {
    const params = new URLSearchParams({
      enablejsapi: "1", autoplay: "1", mute: "1", playsinline: "1", rel: "0",
      origin: location.origin,
      // Offizieller Parameter: sagt YouTube, welche Seite den Player einbettet.
      widget_referrer: location.origin,
    });
    let src;
    if (videoId) src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params}`;
    else {
      params.set("channel", channelId);
      src = `https://www.youtube.com/embed/live_stream?${params}`;
    }
    const iframe = el("iframe", {
      src,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
      allowfullscreen: "",
      title: this.stream.name,
    });
    this.video.replaceChildren(iframe);

    const YT = await withTimeout(loadYouTubeApi(), 15_000, "Die YouTube-Player-API lädt nicht (Netzwerk oder CSP prüfen).");

    // onError und eine Frist: ohne beides bliebe die Kachel bei abgeschalteter
    // Einbettung stumm und ohne Erklärung stehen.
    await withTimeout(
      new Promise((resolve, reject) => {
        const p = new YT.Player(iframe, {
          events: {
            onReady: () => {
              this.player = {
                mute: () => p.mute(),
                unmute: () => { p.unMute(); p.setVolume(this.volume); p.playVideo(); },
                setVolume: (v) => p.setVolume(v),
              };
              resolve();
            },
            onError: (e) => reject(new Error(youtubeErrorText(e.data, Boolean(channelId)))),
          },
        });
        this.cleanups.push(() => { try { p.destroy(); } catch { /* egal */ } });
      }),
      20_000,
      channelId
        ? "Der Player meldet sich nicht. Bei Kanal-Links heißt das meistens: der Kanal ist gerade nicht live."
        : "Der Player meldet sich nicht. Das passiert, wenn YouTube die Einbettung für diese Seite ablehnt.",
    );
    this.ready();
  }

  // ---------- Twitch ----------

  async mountTwitch({ channel, video }) {
    // Twitch lehnt Einbettungen ohne HTTPS ab. Das ist die häufigste Ursache
    // und als Meldung deutlich hilfreicher als ein schwarzes Rechteck.
    const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (location.protocol !== "https:" && !localhost) {
      throw new Error(
        `Twitch-Einbettungen brauchen HTTPS. Diese Seite läuft über ${location.protocol}//${location.hostname} – ` +
        "bitte einen Reverse-Proxy mit HTTPS und einem echten Hostnamen davorsetzen.",
      );
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) {
      throw new Error("Twitch-Einbettungen brauchen einen echten Hostnamen; eine IP-Adresse wird als parent nicht akzeptiert.");
    }

    const Twitch = await withTimeout(loadTwitchApi(), 15_000, "Das Twitch-Player-Skript lädt nicht (Netzwerk oder CSP prüfen).");
    const box = el("div", { id: "twitch-" + this.stream.id });
    this.video.replaceChildren(box);
    const p = new Twitch.Player(box, {
      ...(channel ? { channel } : { video }),
      // Muss genau dem Hostnamen dieser Seite entsprechen.
      parent: [location.hostname],
      width: "100%",
      height: "100%",
      muted: true,
      autoplay: true,
    });
    this.cleanups.push(() => { try { p.destroy?.(); } catch { /* egal */ } });

    let offline = false;
    p.addEventListener(Twitch.Player.OFFLINE, () => {
      offline = true;
      if (!this.player) return;
      this.root.classList.add("offline");
      this.nameEl.title = this.stream.name + " – gerade offline";
    });
    p.addEventListener(Twitch.Player.ONLINE, () => {
      offline = false;
      this.root.classList.remove("offline");
    });

    await withTimeout(
      new Promise((resolve) => p.addEventListener(Twitch.Player.READY, resolve)),
      20_000,
      offline
        ? `Der Twitch-Kanal ${channel || video} ist gerade offline.`
        : "Der Twitch-Player meldet sich nicht. Häufige Ursachen: Kanal offline, Einbettung vom Kanal untersagt, " +
          "oder der parent-Hostname passt nicht zu dieser Seite.",
    );
    this.player = {
      mute: () => p.setMuted(true),
      unmute: () => { p.setMuted(false); p.setVolume(this.volume / 100); p.play(); },
      setVolume: (v) => p.setVolume(v / 100),
    };
    this.ready();
  }

  // ---------- fremde Seite als iframe ----------

  mountIframe(src) {
    this.video.replaceChildren(
      el("iframe", {
        src,
        allow: "autoplay; fullscreen",
        allowfullscreen: "",
        referrerpolicy: "strict-origin-when-cross-origin",
        title: this.stream.name,
      }),
      // Ein blockiertes iframe lässt sich von außen nicht erkennen, deshalb der
      // dauerhafte Hinweis statt einer Fehlermeldung, die nie kommt.
      el("a", { class: "fallback-link", href: src, target: "_blank", rel: "noopener noreferrer" },
        "Lädt nicht? " + providerLabel(src)),
    );
    this.muteBtn.textContent = "Ton im Player";
    this.muteBtn.title = "Bei diesem Anbieter lässt sich der Ton nur im Player selbst steuern";
    this.soloBtn.hidden = true;
    this.vol.hidden = true;
  }

  // ---------- Browser-Wiedergabe (Zusatzmodus) ----------

  async mountBrowser() {
    if (!state.browser.enabled) {
      throw new Error("Für diesen Stream ist die Browser-Wiedergabe eingestellt, der Server hat sie aber nicht eingeschaltet.");
    }
    this.setStatus("Browser-Sitzung wird gestartet …");
    const session = await startBrowserSession(this.stream.id);

    const video = el("video", {
      autoplay: "", playsinline: "", muted: "", class: "browser-video", title: this.stream.name,
    });
    video.muted = true;
    video.volume = this.volume / 100;

    // Am Leben halten, solange die Kachel sichtbar ist. Ohne diese Meldungen
    // räumt der Server die Sitzung nach dem Leerlauf-Timeout ab.
    const keepalive = setInterval(() => {
      browserApi(session.id, "keepalive", session.token).catch(() => {});
    }, 25_000);
    this.cleanups.push(() => clearInterval(keepalive));
    this.cleanups.push(() => {
      // keepalive:true, damit die Abmeldung auch beim Schließen der Seite rausgeht.
      browserApi(session.id, "close", session.token, { keepalive: true }).catch(() => {});
    });

    this.setStatus("Bild und Ton werden verbunden …");
    let pc;
    try {
      pc = await window.BackyardWhep.connect({
        whepUrl: `/api/browser/sessions/${encodeURIComponent(session.id)}/whep`,
        headers: { "X-Session-Token": session.token },
        video,
        onStatus: (msg) => this.setStatus(msg),
      });
    } catch (err) {
      // Häufigster echter Fehler: der Browser des Zuschauers kennt den Codec
      // nicht. Chromium-Bauten mancher Linux-Distributionen haben kein H.264.
      if (/codecs not supported/i.test(err.message)) {
        throw new Error(
          "Dieser Browser kann das gesendete Videoformat nicht abspielen. " +
          "Auf dem Server BROWSER_VIDEO_CODEC=vp8 setzen – VP8 beherrscht jeder WebRTC-Browser.",
        );
      }
      throw err;
    }
    this.cleanups.push(() => { try { pc.close(); } catch { /* egal */ } });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        this.showError(
          "Die WebRTC-Verbindung ist abgebrochen.",
          "Meist fehlt die Freigabe des ICE-Ports 8189 (UDP und TCP) oder BROWSER_PUBLIC_HOST ist falsch gesetzt.",
        );
      }
    });

    this.video.replaceChildren(video);
    this.root.classList.remove("loading");
    this.root.classList.add("browser-mode");
    this.player = {
      mute: () => { video.muted = true; },
      unmute: () => {
        video.muted = false;
        video.volume = this.volume / 100;
        video.play().catch(() => {});
      },
      setVolume: (v) => { video.volume = Math.min(1, Math.max(0, v / 100)); },
    };
    this.ready();
  }

  ready() {
    this.muteBtn.disabled = false;
    this.render();
  }

  setMuted(muted) {
    if (!this.player) return;
    this.muted = muted;
    muted ? this.player.mute() : this.player.unmute();
    this.render();
  }

  toggleBig() {
    const big = this.root.classList.toggle("big");
    store("big:" + this.stream.id, big);
  }

  render() {
    if (!this.player) return;
    this.root.classList.toggle("audible", !this.muted);
    this.muteBtn.textContent = this.muted ? "🔇 Stumm" : "🔊 Laut";
  }

  destroy() {
    this.runCleanups();
    this.root.remove();
  }
}

/** Fehlercodes der YouTube-IFrame-API in verständlichen Text übersetzen. */
function youtubeErrorText(code, isChannelLink) {
  switch (code) {
    case 2:
      return "YouTube lehnt die Video-ID ab – der Link stimmt nicht.";
    case 5:
      return "Der YouTube-HTML5-Player meldet einen Fehler bei diesem Video.";
    case 100:
      return "Das Video gibt es nicht mehr oder es ist privat.";
    case 101:
    case 150:
      return isChannelLink
        ? "Der Kanal erlaubt keine Einbettung seines Livestreams, oder es läuft gerade keiner."
        : "Der Rechteinhaber hat die Einbettung dieses Videos auf anderen Seiten untersagt. Das lässt sich hier nicht umgehen.";
    default:
      return `YouTube meldet Fehler ${code}.`;
  }
}

// ---------- Browser-Wiedergabe: Server und WebRTC ----------

function browserApi(sessionId, action, token, extra = {}) {
  return fetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    headers: { "X-Session-Token": token, ...(extra.headers || {}) },
    body: extra.body,
    keepalive: Boolean(extra.keepalive),
  });
}

async function startBrowserSession(streamId, retry = true) {
  const headers = { "Content-Type": "application/json" };
  const pw = store("browserPassword");
  if (pw) headers["X-Browser-Password"] = pw;
  const res = await fetch("/api/browser/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ streamId }),
  });
  if (res.status === 401 && retry) {
    const entered = prompt("Passwort für die Browser-Wiedergabe:");
    if (entered === null) throw new Error("Browser-Wiedergabe abgebrochen – Passwort erforderlich.");
    store("browserPassword", entered);
    return startBrowserSession(streamId, false);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Sitzung konnte nicht gestartet werden (${res.status}).`);
  return body;
}

// ---------- Ton steuern ----------

const controllable = () => [...state.tiles.values()].filter((t) => t.player);

function toggle(tile) {
  if (!tile.player) return;
  if (tile.muted && $("#exclusive").checked) return solo(tile);
  tile.setMuted(!tile.muted);
  updateStatus();
}

function solo(tile) {
  for (const t of controllable()) if (t !== tile && !t.muted) t.setMuted(true);
  tile.setMuted(false);
  updateStatus();
}

function muteAll() {
  for (const t of controllable()) if (!t.muted) t.setMuted(true);
  updateStatus();
}

function updateStatus() {
  const on = controllable().filter((t) => !t.muted).map((t) => t.stream.name);
  const status = $("#audio-status");
  status.textContent = on.length ? "🔊 " + on.join(", ") : "Alle stumm";
  status.classList.toggle("on", on.length > 0);
}

// ---------- Raster aufbauen ----------

function renderGrid() {
  const seen = new Set();
  state.streams.forEach((s, i) => {
    let tile = state.tiles.get(s.id);
    // Neu einbinden nur, wenn sich Link oder Wiedergabeart geändert haben –
    // sonst läuft der Stream weiter.
    if (tile && (tile.stream.url !== s.url || tile.stream.mode !== s.mode)) {
      tile.destroy();
      tile = null;
    }
    if (!tile) {
      tile = new Tile(s);
      state.tiles.set(s.id, tile);
      grid.append(tile.root);
    }
    tile.stream = s;
    tile.nameEl.lastChild.textContent = s.name;
    tile.nameEl.title = s.name;
    tile.idx.textContent = i < 9 ? i + 1 + "" : "";
    // Reihenfolge per CSS – ein iframe im DOM zu verschieben würde ihn neu laden.
    tile.root.style.order = i;
    seen.add(s.id);
  });
  for (const [id, tile] of state.tiles) {
    if (!seen.has(id)) {
      tile.destroy();
      state.tiles.delete(id);
    }
  }
  $("#empty").hidden = state.streams.length > 0;
  updateStatus();
}

function applyColumns() {
  const v = $("#columns").value;
  grid.style.gridTemplateColumns = v === "auto" ? "" : `repeat(${v}, minmax(0, 1fr))`;
  store("columns", v);
}

// ---------- Editor ----------

function renderEditor() {
  const list = $("#edit-list");
  list.replaceChildren(...state.streams.map((s, i) => {
    const name = el("input", { name: "name", value: s.name, maxlength: "80" });
    const url = el("input", { name: "url", value: s.url });
    const commit = () => {
      if (name.value.trim() === s.name && url.value.trim() === s.url) return;
      edit((streams) => {
        const t = streams.find((x) => x.id === s.id);
        t.name = name.value.trim();
        t.url = url.value.trim();
      });
    };
    name.addEventListener("change", commit);
    url.addEventListener("change", commit);

    const row = el("li", {},
      el("span", { class: "num" }, i + 1 + "."),
      name, url,
    );

    if (state.browser.enabled) {
      const box = el("input", { type: "checkbox", ...(s.mode === "browser" ? { checked: "" } : {}) });
      box.addEventListener("change", () =>
        edit((streams) => {
          const t = streams.find((x) => x.id === s.id);
          if (box.checked) t.mode = "browser";
          else delete t.mode;
        }),
      );
      row.append(el("label", { class: "mode", title: "Serverseitigen Browser verwenden (nur für eigene oder ausdrücklich freigegebene Quellen)" }, box, "Browser"));
    }

    row.append(
      el("button", { class: "btn small", title: "Prüfen, warum die Einbettung nicht läuft", onclick: () => runDiagnose(s.url) }, "Diagnose"),
      el("button", { class: "btn small", title: "Nach oben", onclick: () => move(i, -1) }, "↑"),
      el("button", { class: "btn small", title: "Nach unten", onclick: () => move(i, 1) }, "↓"),
      el("button", { class: "btn small danger", title: "Entfernen", onclick: () => {
        if (confirm(`„${s.name}“ entfernen?`)) edit((streams) => streams.splice(i, 1));
      } }, "✕"),
    );
    return row;
  }));
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.streams.length) return;
  edit((streams) => ([streams[i], streams[j]] = [streams[j], streams[i]]));
}

function message(text, isError = false) {
  const m = $("#editor-msg");
  m.textContent = text;
  m.classList.toggle("error", isError);
}

/** Server-Diagnose für einen Link anzeigen. */
async function runDiagnose(url) {
  const out = $("#diagnose-out");
  out.hidden = false;
  out.textContent = "Wird geprüft …";
  try {
    const res = await fetch("/api/diagnose?url=" + encodeURIComponent(url));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Fehler ${res.status}`);
    const lines = [`${body.url}`, `Erkannt als: ${body.kind || "unbekannt"}`, ""];
    for (const c of body.checks || []) lines.push(`• ${c.check} [HTTP ${c.status}]: ${c.detail}`);
    if (body.verdict) lines.push("", "Ergebnis: " + body.verdict);
    out.textContent = lines.join("\n");
  } catch (err) {
    out.textContent = "Diagnose fehlgeschlagen: " + err.message;
  }
}

async function resolveHandle(url) {
  const res = await fetch("/api/resolve?url=" + encodeURIComponent(url));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Kanal nicht gefunden");
  return "https://www.youtube.com/channel/" + body.channelId;
}

async function normalizeUrl(url) {
  return parseStreamUrl(url).kind === "youtube-handle" ? resolveHandle(url) : url;
}

async function edit(mutator) {
  const next = structuredClone(state.streams);
  mutator(next);
  try {
    for (const s of next) s.url = await normalizeUrl(s.url);
    await save(next);
    message("Gespeichert.");
  } catch (err) {
    message(err.message, true);
  }
  renderEditor();
}

async function save(streams) {
  const res = await fetch("/api/streams", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(streams),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Speichern fehlgeschlagen");
  state.streams = body;
  renderGrid();
}

// ---------- Start ----------

async function init() {
  $("#exclusive").checked = store("exclusive") ?? true;
  $("#exclusive").addEventListener("change", (e) => store("exclusive", e.target.checked));

  $("#columns").value = store("columns") ?? "auto";
  $("#columns").addEventListener("change", applyColumns);
  applyColumns();

  $("#mute-all").addEventListener("click", muteAll);
  $("#edit-toggle").addEventListener("click", () => {
    const ed = $("#editor");
    ed.hidden = !ed.hidden;
    if (!ed.hidden) renderEditor();
  });

  $("#add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.namedItem("name").value.trim();
    const url = form.elements.namedItem("url").value.trim();
    if (parseStreamUrl(url).kind === "invalid") return message("Ungültiger Link.", true);
    edit((streams) => streams.push({ id: crypto.randomUUID(), name, url })).then(() => {
      if (!$("#editor-msg").classList.contains("error")) form.reset();
      form.elements.namedItem("name").focus();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") return muteAll();
    const n = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!n) return;
    const s = state.streams[Number(n) - 1];
    const tile = s && state.tiles.get(s.id);
    if (!tile) return;
    e.shiftKey ? solo(tile) : toggle(tile);
  });

  // Browser-Sitzungen beim Verlassen der Seite freigeben, statt auf das
  // Leerlauf-Timeout zu warten.
  window.addEventListener("pagehide", () => {
    for (const tile of state.tiles.values()) if (tile.stream.mode === "browser") tile.destroy();
  });

  state.browser = await fetch("/api/browser/config")
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .catch(() => ({ enabled: false }));
  document.body.classList.toggle("browser-available", Boolean(state.browser.enabled));
  for (const node of document.querySelectorAll(".browser-only")) node.hidden = !state.browser.enabled;

  const res = await fetch("/api/streams");
  state.streams = await res.json();
  renderGrid();
  if (!state.streams.length) {
    $("#editor").hidden = false;
    renderEditor();
  }
}

init();
