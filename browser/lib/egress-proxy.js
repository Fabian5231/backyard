// Egress-Proxy für den serverseitigen Chromium.
//
// Chromium wird mit --proxy-server auf diesen Proxy gezeigt, inklusive
// --proxy-bypass-list="<-loopback>". Damit läuft *jede* HTTP(S)-Anfrage des
// Browsers hier durch – auch Unterressourcen, Weiterleitungen und Anfragen aus
// Skripten. Der Proxy lässt nur freigegebene Hosts durch und löst den Namen
// selbst auf, um dann genau zur geprüften IP zu verbinden. Ein DNS-Eintrag, der
// auf 127.0.0.1 oder 169.254.169.254 zeigt, kommt deshalb nicht durch.
//
// Der Proxy lauscht nur auf 127.0.0.1 im Container.

"use strict";

const http = require("http");
const net = require("net");
const dns = require("dns").promises;
const { hostNameAllowed, hostAllowed, ipAllowed } = require("./guard");

const ALLOWED_PORTS = new Set([80, 443]);

/**
 * @param {object} opts
 * @param {() => string[]} opts.allowList  aktuelle Hostfreigabe (wird pro Anfrage gelesen)
 * @param {(line: string) => void} [opts.log]
 */
function createEgressProxy({ allowList, log = () => {} }) {
  const blocked = new Map(); // host -> Anzahl, damit Admins sehen, was fehlt

  function note(host, reason) {
    const key = `${host} (${reason})`;
    blocked.set(key, (blocked.get(key) || 0) + 1);
    if (blocked.get(key) <= 3) log(`blockiert: ${key}`);
  }

  /** Namen prüfen, auflösen, jede Antwort-IP prüfen. */
  async function resolveChecked(host) {
    const byName = hostNameAllowed(host);
    if (!byName.allowed) return { error: byName.reason };
    if (!hostAllowed(host, allowList())) return { error: "nicht freigegeben" };

    let records;
    try {
      records = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
      return { error: `DNS fehlgeschlagen (${err.code || err.message})` };
    }
    const usable = [];
    for (const r of records) {
      const verdict = ipAllowed(r.address, r.family);
      if (verdict.allowed) usable.push(r);
      else return { error: verdict.reason }; // eine gesperrte Antwort sperrt den Host
    }
    if (!usable.length) return { error: "keine nutzbare Adresse" };
    return { records: usable };
  }

  function connectChecked(host, port, cb) {
    if (!ALLOWED_PORTS.has(port)) return cb(new Error(`Port ${port} nicht zugelassen`));
    resolveChecked(host).then(({ records, error }) => {
      if (error) return cb(new Error(error));
      // Zur geprüften IP verbinden, nicht erneut per Name – sonst wäre
      // zwischen Prüfung und Verbindung ein DNS-Wechsel möglich.
      const socket = net.connect({ host: records[0].address, port, family: records[0].family });
      socket.setNoDelay(true);
      socket.once("connect", () => cb(null, socket));
      socket.once("error", (err) => cb(err));
    }, cb);
  }

  const server = http.createServer();

  // Normales HTTP (Chromium sendet die absolute URL an den Proxy).
  server.on("request", (req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    const port = Number(target.port) || 80;
    connectChecked(target.hostname, port, (err, socket) => {
      if (err) {
        note(target.hostname, err.message);
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Backyard: Ziel nicht freigegeben – ${err.message}`);
        return;
      }
      const upstream = http.request(
        {
          // Kein agent:false ergänzen – damit würde Node einen eigenen Agent
          // anlegen, createConnection ignorieren und selbst auflösen. Genau das
          // soll hier nicht passieren: verbunden wird zur geprüften IP.
          createConnection: () => socket,
          host: target.hostname,
          port,
          method: req.method,
          path: target.pathname + target.search,
          headers: { ...req.headers, host: target.host },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end("Bad gateway"));
      req.pipe(upstream);
    });
  });

  // HTTPS: Tunnel. Der Proxy sieht nur den Zielhost, nie den Inhalt.
  server.on("connect", (req, clientSocket, head) => {
    const [rawHost, rawPort] = String(req.url).split(":");
    const host = rawHost.replace(/^\[|\]$/g, "");
    const port = Number(rawPort) || 443;
    connectChecked(host, port, (err, upstream) => {
      if (err) {
        note(host, err.message);
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.setNoDelay(true);
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const close = () => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on("error", close);
      clientSocket.on("error", close);
    });
  });

  server.on("clientError", (_err, socket) => socket.destroy());

  return {
    server,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
    blockedHosts: () => Object.fromEntries(blocked),
  };
}

module.exports = { createEgressProxy };
