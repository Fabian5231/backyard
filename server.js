// Backyard Streams – kleiner Server ohne Abhängigkeiten.
// Liefert die Weboberfläche aus und speichert die Stream-Liste in data/streams.json.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "streams.json");
const PUBLIC_DIR = path.join(__dirname, "public");

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
    return { id: String(s.id || crypto.randomUUID()).slice(0, 64), name, url };
  });
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-admin-password"] || ""));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/streams") {
    if (req.method === "GET") return send(res, 200, readStreams());
    if (req.method === "PUT") {
      if (!isAdmin(req)) return send(res, 401, { error: "Falsches Passwort" });
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
  if (url.pathname === "/api/resolve") {
    const m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[\w.\-]{1,100})/i.exec(url.searchParams.get("url") || "");
    if (!m) return send(res, 400, { error: "Nur youtube.com/@name-Links werden aufgelöst" });
    try {
      const r = await fetch(`https://www.youtube.com/${m[1]}`, {
        headers: { "Accept-Language": "en", Cookie: "SOCS=CAI; CONSENT=YES+1" },
        signal: AbortSignal.timeout(8000),
      });
      const html = await r.text();
      const id =
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1] ||
        /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1];
      if (!id) return send(res, 404, { error: `Kanal ${m[1]} nicht gefunden – bitte Video- oder /channel/UC…-Link verwenden` });
      return send(res, 200, { channelId: id });
    } catch {
      return send(res, 502, { error: "YouTube nicht erreichbar – bitte Video- oder /channel/UC…-Link verwenden" });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Methode nicht erlaubt" });

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden", "text/plain");

  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : content);
  });
});

server.listen(PORT, () => {
  console.log(`Backyard Streams läuft auf http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.log("Hinweis: ADMIN_PASSWORD ist nicht gesetzt – jeder kann die Stream-Liste ändern.");
});
