// Prüft die Server-Endpunkte, inklusive der Schalter für die Browser-Wiedergabe.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Server als eigener Prozess starten – die Schalter werden beim Laden gelesen. */
async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bys-test-"));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (b) => log.push(String(b)));
  child.stderr.on("data", (b) => log.push(String(b)));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fetch(base + "/api/streams");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("Server startet nicht: " + log.join(""));
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    base,
    log: () => log.join(""),
    async stop() {
      child.kill("SIGKILL");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const put = (base, body) =>
  fetch(base + "/api/streams", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("Stream-Liste lesen und schreiben, ohne Passwort", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.deepEqual(await (await fetch(srv.base + "/api/streams")).json(), []);

  const ok = await put(srv.base, [{ name: "A", url: "https://example.com/a" }]);
  assert.equal(ok.status, 200);
  const list = await ok.json();
  assert.equal(list.length, 1);
  assert.ok(list[0].id, "id wird ergänzt");
});

test("ungültige Einträge werden abgelehnt", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  for (const body of [
    [{ name: "", url: "https://example.com" }],
    [{ name: "A", url: "" }],
    [{ name: "A", url: "javascript:alert(1)" }],
    [{ name: "A", url: "ftp://example.com" }],
    "keine Liste",
  ]) {
    const res = await put(srv.base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("mode=browser wird verworfen, solange die Browser-Wiedergabe aus ist", async (t) => {
  const srv = await startServer({ BROWSER_PLAYBACK: "0" });
  t.after(() => srv.stop());

  const list = await (await put(srv.base, [{ name: "A", url: "https://example.com/a", mode: "browser" }])).json();
  assert.equal(list[0].mode, undefined);

  // Und die Endpunkte sind gar nicht da.
  assert.equal((await fetch(srv.base + "/api/browser/config")).status, 404);
});

test("mode=browser bleibt erhalten, wenn die Browser-Wiedergabe an ist", async (t) => {
  const srv = await startServer({ BROWSER_PLAYBACK: "1", BROWSER_SERVICE_TOKEN: "t" });
  t.after(() => srv.stop());

  const list = await (await put(srv.base, [
    { name: "A", url: "https://example.com/a", mode: "browser" },
    { name: "B", url: "https://example.com/b" },
  ])).json();
  assert.equal(list[0].mode, "browser");
  assert.equal(list[1].mode, undefined);

  const cfg = await (await fetch(srv.base + "/api/browser/config")).json();
  assert.deepEqual(cfg, { enabled: true, requiresPassword: false });
});

test("Browser-Sitzung: Zuschauer können keine beliebige URL öffnen lassen", async (t) => {
  const srv = await startServer({ BROWSER_PLAYBACK: "1", BROWSER_SERVICE_TOKEN: "t" });
  t.after(() => srv.stop());

  await put(srv.base, [{ id: "normal", name: "N", url: "https://example.com/n" }]);

  const post = (body) =>
    fetch(srv.base + "/api/browser/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Eine URL direkt mitzuschicken hat keine Wirkung: der Server nimmt nur eine
  // Stream-Id und holt die Adresse selbst aus der gespeicherten Liste.
  assert.equal((await post({ url: "http://169.254.169.254/latest/meta-data/" })).status, 404);
  assert.equal((await post({ streamId: "gibtsnicht" })).status, 404);
  // Vorhandener Stream, aber ohne mode=browser -> abgelehnt.
  assert.equal((await post({ streamId: "normal" })).status, 400);
});

test("Browser-Passwort wird verlangt, wenn es gesetzt ist", async (t) => {
  const srv = await startServer({
    BROWSER_PLAYBACK: "1", BROWSER_SERVICE_TOKEN: "t", BROWSER_VIEWER_PASSWORD: "zuschauer",
  });
  t.after(() => srv.stop());

  await put(srv.base, [{ id: "b", name: "B", url: "https://example.com/b", mode: "browser" }]);

  const cfg = await (await fetch(srv.base + "/api/browser/config")).json();
  assert.equal(cfg.requiresPassword, true);

  const ohne = await fetch(srv.base + "/api/browser/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streamId: "b" }),
  });
  assert.equal(ohne.status, 401);
});

test("Sitzungsendpunkte brauchen ein Token in gültiger Form", async (t) => {
  const srv = await startServer({ BROWSER_PLAYBACK: "1", BROWSER_SERVICE_TOKEN: "t" });
  t.after(() => srv.stop());

  for (const token of ["", "kurz", "nicht-hex-zeichen!!"]) {
    const res = await fetch(srv.base + "/api/browser/sessions/s1/keepalive", {
      method: "POST", headers: { "X-Session-Token": token },
    });
    assert.equal(res.status, 401, token);
  }
});

test("Diagnose nimmt nur YouTube/Twitch", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const res = await fetch(srv.base + "/api/diagnose?url=https://example.com/");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /YouTube- und Twitch/);
});

test("Kanal-Auflösung nimmt nur youtube.com/@name-Links", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const res = await fetch(srv.base + "/api/resolve?url=https://example.com/");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /@name-Links/);
});

test("statische Dateien: kein Ausbruch aus public/", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  assert.equal((await fetch(srv.base + "/")).status, 200);
  assert.equal((await fetch(srv.base + "/browser-test-source.html")).status, 200);
  for (const p of ["/../server.js", "/..%2fserver.js", "/%2e%2e/%2e%2e/etc/passwd"]) {
    const res = await fetch(srv.base + p, { redirect: "manual" });
    assert.ok(res.status === 403 || res.status === 404, `${p} -> ${res.status}`);
  }
});

test("Antworten setzen eine Referrer-Policy, die Embeds nicht bricht", async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const res = await fetch(srv.base + "/");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("Startlimit greift und zählt pro Adresse, wenn TRUST_PROXY gesetzt ist", async (t) => {
  const srv = await startServer({
    BROWSER_PLAYBACK: "1", BROWSER_SERVICE_TOKEN: "t", BROWSER_STARTS_PER_MINUTE: "3", TRUST_PROXY: "1",
  });
  t.after(() => srv.stop());

  await put(srv.base, [{ id: "b", name: "B", url: "https://example.com/b", mode: "browser" }]);

  const start = (ip) =>
    fetch(srv.base + "/api/browser/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ streamId: "b" }),
    });

  // Der Browser-Dienst ist im Test nicht erreichbar -> 502. Entscheidend ist,
  // dass ab dem vierten Versuch 429 kommt und nicht mehr weitergeleitet wird.
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await start("203.0.113.5")).status);
  assert.equal(codes.filter((c) => c === 429).length, 2, `Statuscodes: ${codes}`);

  // Eine andere Adresse hat ihr eigenes Budget.
  assert.notEqual((await start("203.0.113.6")).status, 429);
});
