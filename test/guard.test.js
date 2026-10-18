// Prüft die Zielbeschränkung der Browser-Wiedergabe.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { expandAllowList, hostAllowed, hostNameAllowed, ipAllowed, checkTargetUrl } =
  require("../browser/lib/guard");

test("Presets werden zu Hostlisten aufgelöst", () => {
  const list = expandAllowList(["youtube"]);
  assert.ok(list.includes("youtube.com"));
  // Ohne die Medien-Domain lädt die Seite, aber kein Video.
  assert.ok(list.includes("googlevideo.com"));
});

test("eigene Hosts werden übernommen und normalisiert", () => {
  assert.deepEqual(expandAllowList([" Streams.Example.COM. ", "*.cdn.example"]).sort(),
    ["cdn.example", "streams.example.com"]);
});

test("Freigabe gilt auch für Subdomains, aber nicht für Namensanhänge", () => {
  const list = ["example.com"];
  assert.equal(hostAllowed("example.com", list), true);
  assert.equal(hostAllowed("live.example.com", list), true);
  assert.equal(hostAllowed("example.com.angreifer.test", list), false);
  assert.equal(hostAllowed("notexample.com", list), false);
});

test("localhost und interne Namen sind gesperrt", () => {
  for (const host of ["localhost", "metadata.google.internal", "db.internal", "nas.local", "foo.cluster.local"]) {
    assert.equal(hostNameAllowed(host).allowed, false, host);
  }
});

test("IP-Adressen als Ziel werden abgelehnt", () => {
  assert.equal(hostNameAllowed("93.184.216.34").allowed, false);
  assert.equal(hostNameAllowed("2606:2800:220:1:248:1893:25c8:1946").allowed, false);
});

test("private, loopback- und Metadaten-Adressen sind gesperrt", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.1.2.3", "172.17.0.2", "172.31.255.254",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255",
  ];
  for (const ip of blocked) assert.equal(ipAllowed(ip, 4).allowed, false, ip);
});

test("öffentliche Adressen sind erlaubt", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255"]) {
    assert.equal(ipAllowed(ip, 4).allowed, true, ip);
  }
});

test("IPv6: loopback, ULA, link-local und Multicast sind gesperrt", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "64:ff9b::1.2.3.4"]) {
    assert.equal(ipAllowed(ip, 6).allowed, false, ip);
  }
  assert.equal(ipAllowed("2606:4700::1111", 6).allowed, true);
});

test("IPv4-gemappte IPv6-Adressen umgehen die Sperre nicht", () => {
  assert.equal(ipAllowed("::ffff:127.0.0.1", 6).allowed, false);
  assert.equal(ipAllowed("::ffff:169.254.169.254", 6).allowed, false);
  // Dieselbe Adresse hexadezimal notiert: ::ffff:a9fe:a9fe
  assert.equal(ipAllowed("::ffff:a9fe:a9fe", 6).allowed, false);
  assert.equal(ipAllowed("::ffff:a00:1", 6).allowed, false); // 10.0.0.1
});

test("checkTargetUrl lässt nur freigegebene https/http-Ziele zu", () => {
  const list = ["example.com"];
  assert.equal(checkTargetUrl("https://live.example.com/stream", list).ok, true);
  assert.equal(checkTargetUrl("http://live.example.com/stream", list).ok, true);
  assert.equal(checkTargetUrl("https://andere.test/stream", list).ok, false);
  assert.equal(checkTargetUrl("file:///etc/passwd", list).ok, false);
  assert.equal(checkTargetUrl("chrome://settings", list).ok, false);
  assert.equal(checkTargetUrl("https://user:pass@example.com/", list).ok, false);
  assert.equal(checkTargetUrl("kein-link", list).ok, false);
  // Auch mit Freigabe bleibt localhost gesperrt.
  assert.equal(checkTargetUrl("http://localhost:8080/", ["localhost"]).ok, false);
  assert.equal(checkTargetUrl("http://127.0.0.1:8080/", ["127.0.0.1"]).ok, false);
});

test("ohne Freigabeliste ist nichts erlaubt", () => {
  assert.equal(checkTargetUrl("https://example.com/", []).ok, false);
});
