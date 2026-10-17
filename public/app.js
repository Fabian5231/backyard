// Backyard Streams – Oberfläche: Streams einbinden und pro Stream stumm/laut schalten.
"use strict";

const $ = (sel) => document.querySelector(sel);
const grid = $("#grid");

const state = {
  streams: [],
  tiles: new Map(), // id -> Tile
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

let ytReady;
function loadYouTubeApi() {
  if (!ytReady) {
    ytReady = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    });
    loadScript("https://www.youtube.com/iframe_api");
  }
  return ytReady;
}

let twitchReady;
function loadTwitchApi() {
  twitchReady ??= loadScript("https://player.twitch.tv/js/embed/v1.js").then(() => window.Twitch);
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

// ---------- Kachel pro Stream ----------

class Tile {
  constructor(stream) {
    this.stream = stream;
    this.muted = true;
    this.volume = store("vol:" + stream.id) ?? 80;
    this.player = null; // { mute(), unmute(), setVolume(0..100) }

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

  async mount() {
    const info = parseStreamUrl(this.stream.url);
    try {
      if (info.kind === "youtube") await this.mountYouTube(info);
      else if (info.kind === "twitch") await this.mountTwitch(info);
      else if (info.kind === "iframe") this.mountIframe(info.src);
      else throw new Error("Link wird nicht unterstützt: " + this.stream.url);
    } catch (err) {
      this.video.replaceChildren(el("div", { class: "error" }, err.message));
    }
  }

  async mountYouTube({ videoId, channelId }) {
    const params = new URLSearchParams({
      enablejsapi: "1", autoplay: "1", mute: "1", playsinline: "1", rel: "0", origin: location.origin,
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

    const YT = await loadYouTubeApi();
    await new Promise((resolve) => {
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
        },
      });
    });
    this.ready();
  }

  async mountTwitch({ channel, video }) {
    const Twitch = await loadTwitchApi();
    const box = el("div", { id: "twitch-" + this.stream.id });
    this.video.replaceChildren(box);
    const p = new Twitch.Player(box, {
      ...(channel ? { channel } : { video }),
      parent: [location.hostname],
      width: "100%",
      height: "100%",
      muted: true,
      autoplay: true,
    });
    p.addEventListener(Twitch.Player.READY, () => {
      this.player = {
        mute: () => p.setMuted(true),
        unmute: () => { p.setMuted(false); p.setVolume(this.volume / 100); p.play(); },
        setVolume: (v) => p.setVolume(v / 100),
      };
      this.ready();
    });
  }

  mountIframe(src) {
    this.video.replaceChildren(el("iframe", { src, allow: "autoplay; fullscreen", allowfullscreen: "", title: this.stream.name }));
    this.muteBtn.textContent = "Ton im Player";
    this.muteBtn.title = "Bei diesem Anbieter lässt sich der Ton nur im Player selbst steuern";
    this.soloBtn.hidden = true;
    this.vol.hidden = true;
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
    this.root.remove();
  }
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
    // Neu einbinden nur, wenn sich der Link geändert hat – sonst läuft der Stream weiter.
    if (tile && tile.stream.url !== s.url) {
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
    return el("li", {},
      el("span", { class: "num" }, i + 1 + "."),
      name, url,
      el("button", { class: "btn small", title: "Nach oben", onclick: () => move(i, -1) }, "↑"),
      el("button", { class: "btn small", title: "Nach unten", onclick: () => move(i, 1) }, "↓"),
      el("button", { class: "btn small danger", title: "Entfernen", onclick: () => {
        if (confirm(`„${s.name}“ entfernen?`)) edit((streams) => streams.splice(i, 1));
      } }, "✕"),
    );
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

async function save(streams, retry = true) {
  const headers = { "Content-Type": "application/json" };
  const pw = store("password");
  if (pw) headers["X-Admin-Password"] = pw;
  const res = await fetch("/api/streams", { method: "PUT", headers, body: JSON.stringify(streams) });
  if (res.status === 401 && retry) {
    const entered = prompt("Admin-Passwort zum Bearbeiten:");
    if (entered === null) throw new Error("Nicht gespeichert – Passwort erforderlich.");
    store("password", entered);
    return save(streams, true);
  }
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

  const res = await fetch("/api/streams");
  state.streams = await res.json();
  renderGrid();
  if (!state.streams.length) {
    $("#editor").hidden = false;
    renderEditor();
  }
}

init();
