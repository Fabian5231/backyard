// Prüft den Egress-Proxy, durch den jede Anfrage des serverseitigen Browsers läuft.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createEgressProxy } = require("../browser/lib/egress-proxy");

/** Einen CONNECT-Tunnel anfragen und nur die Statuszeile zurückgeben. */
function connectRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("Zeitüberschreitung"));
    });
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
  });
}

async function withProxy(allowList, fn) {
  const proxy = createEgressProxy({ allowList: () => allowList, log: () => {} });
  const port = await proxy.listen(0, "127.0.0.1");
  try {
    return await fn(port, proxy);
  } finally {
    await proxy.close();
  }
}

test("nicht freigegebene Hosts werden abgelehnt", async () => {
  await withProxy(["example.com"], async (port) => {
    assert.match(await connectRequest(port, "fremde-seite.test:443"), /403/);
  });
});

test("interne Namen werden abgelehnt, auch wenn sie freigegeben sind", async () => {
  await withProxy(["localhost", "metadata.google.internal", "dienst.internal"], async (port) => {
    for (const target of ["localhost:443", "metadata.google.internal:443", "dienst.internal:80"]) {
      assert.match(await connectRequest(port, target), /403/, target);
    }
  });
});

test("nur Port 80 und 443 sind erlaubt", async () => {
  await withProxy(["example.com"], async (port) => {
    assert.match(await connectRequest(port, "example.com:22"), /403/);
    assert.match(await connectRequest(port, "example.com:6379"), /403/);
  });
});

/** Anfrage in absoluter Form schicken – so sprechen Browser mit einem Proxy. */
function absoluteFormRequest(port, url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("Zeitüberschreitung"));
    });
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

test("normales HTTP: nicht freigegebene Ziele bekommen eine Begründung", async () => {
  await withProxy(["example.com"], async (port) => {
    const res = await absoluteFormRequest(port, "http://fremde-seite.test/video.m3u8");
    assert.match(res.split("\r\n")[0], /403/);
    assert.match(res, /nicht freigegeben/);
  });
});

test("normales HTTP: interner Name wird auch mit Freigabe abgelehnt", async () => {
  await withProxy(["dienst.internal"], async (port) => {
    const res = await absoluteFormRequest(port, "http://dienst.internal/admin");
    assert.match(res.split("\r\n")[0], /403/);
  });
});

test("blockierte Hosts werden für den Admin mitgezählt", async () => {
  await withProxy(["example.com"], async (port, proxy) => {
    await connectRequest(port, "cdn.fremd.test:443");
    const blocked = proxy.blockedHosts();
    const keys = Object.keys(blocked);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /cdn\.fremd\.test/);
    assert.match(keys[0], /nicht freigegeben/);
  });
});

test("IP-Adressen als Ziel werden abgelehnt, auch die Metadaten-Adresse", async () => {
  await withProxy(["169.254.169.254", "127.0.0.1", "10.0.0.1"], async (port) => {
    for (const target of ["169.254.169.254:80", "127.0.0.1:80", "10.0.0.1:443"]) {
      assert.match(await connectRequest(port, target), /403/, target);
    }
  });
});
