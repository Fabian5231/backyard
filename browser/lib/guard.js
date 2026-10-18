// Zielprüfung für die Browser-Wiedergabe.
//
// Zwei Fragen, die unabhängig voneinander beantwortet werden:
//   1. Darf dieser Host überhaupt geöffnet werden? (administrative Freigabe)
//   2. Zeigt der Name auf eine Adresse, die der Browser nicht erreichen darf?
//      (localhost, interne Netze, Cloud-Metadaten)
//
// Punkt 2 wird nicht am Namen, sondern an der *aufgelösten* IP geprüft und
// zwar unmittelbar vor dem Verbindungsaufbau. Nur so greift die Prüfung auch
// bei DNS-Rebinding, Weiterleitungen und Unterressourcen.

"use strict";

// Hosts, die für eine Plattform zusätzlich gebraucht werden (CDN, Medien,
// Schriften). Ohne sie lädt die Seite, aber das Video nicht.
// Best effort: Plattformen ändern ihre CDN-Domains. Blockierte Hosts stehen im
// Log des Egress-Proxys – von dort lässt sich die Liste nachziehen.
const PRESETS = {
  youtube: [
    "youtube.com", "youtu.be", "youtube-nocookie.com", "ytimg.com",
    "googlevideo.com", "ggpht.com", "gstatic.com", "googleapis.com",
    "google.com", "youtubei.googleapis.com",
  ],
  twitch: [
    "twitch.tv", "ttvnw.net", "jtvnw.net", "twitchcdn.net", "twitchsvc.net",
    "live-video.net", "twimg.com",
  ],
};

// Adressbereiche, die eine normale Wiedergabeseite nie braucht und über die
// der Browser sonst Host-Dienste oder Cloud-Metadaten erreichen könnte.
const BLOCKED_V4 = [
  ["0.0.0.0", 8],          // "dieses Netz"
  ["10.0.0.0", 8],         // privat
  ["100.64.0.0", 10],      // Carrier-NAT
  ["127.0.0.0", 8],        // loopback
  ["169.254.0.0", 16],     // link-local, enthält 169.254.169.254 (Metadaten)
  ["172.16.0.0", 12],      // privat (Docker-Bridges)
  ["192.0.0.0", 24],       // IETF-Protokollzuweisungen
  ["192.168.0.0", 16],     // privat
  ["198.18.0.0", 15],      // Benchmark
  ["224.0.0.0", 4],        // Multicast
  ["240.0.0.0", 4],        // reserviert, inkl. 255.255.255.255
];

// Namen, die typischerweise auf interne Dienste zeigen.
const BLOCKED_SUFFIXES = [".internal", ".local", ".localdomain", ".localhost", ".cluster.local"];
const BLOCKED_NAMES = ["localhost", "metadata", "metadata.google.internal", "instance-data"];

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/** Erweitert Presetnamen zu Hostlisten; unbekannte Namen bleiben als Host stehen. */
function expandAllowList(entries) {
  const out = new Set();
  for (const raw of entries || []) {
    const entry = normalizeHost(raw).replace(/^\*\./, "");
    if (!entry) continue;
    if (PRESETS[entry]) for (const h of PRESETS[entry]) out.add(h);
    else out.add(entry);
  }
  return [...out];
}

/** Passt `host` auf einen Freigabeeintrag? Ein Eintrag deckt auch alle Subdomains ab. */
function hostAllowed(host, allowList) {
  const h = normalizeHost(host);
  if (!h) return false;
  return (allowList || []).some((entry) => h === entry || h.endsWith("." + entry));
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4Block(ip, [base, bits]) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * Darf zu dieser IP verbunden werden?
 * @returns {{allowed: boolean, reason?: string}}
 */
function ipAllowed(address, family) {
  const ip = normalizeHost(address);
  if (!ip) return { allowed: false, reason: "keine Adresse" };

  if (family === 4 || ipv4ToInt(ip) !== null) {
    for (const block of BLOCKED_V4) {
      if (inV4Block(ip, block)) return { allowed: false, reason: `Adresse in ${block[0]}/${block[1]}` };
    }
    return { allowed: true };
  }

  // IPv4-gemappte IPv6-Adressen (::ffff:10.0.0.1) mit der IPv4-Logik prüfen.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipAllowed(mapped[1], 4);
  // ::ffff:a00:1 – gemappt, aber hexadezimal notiert.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return ipAllowed(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 4);
  }

  if (ip === "::" || ip === "::1") return { allowed: false, reason: "IPv6-loopback" };
  const head = ip.split(":")[0];
  const v = parseInt(head, 16);
  if (Number.isNaN(v)) return { allowed: false, reason: "unlesbare IPv6-Adresse" };
  if ((v & 0xfe00) === 0xfc00) return { allowed: false, reason: "IPv6 ULA fc00::/7" };
  if ((v & 0xffc0) === 0xfe80) return { allowed: false, reason: "IPv6 link-local fe80::/10" };
  if ((v & 0xff00) === 0xff00) return { allowed: false, reason: "IPv6-Multicast" };
  if (ip.startsWith("64:ff9b:")) return { allowed: false, reason: "NAT64-Präfix" };
  if (ip.startsWith("2001:db8:")) return { allowed: false, reason: "Dokumentationspräfix" };
  if (ip.startsWith("100::")) return { allowed: false, reason: "Discard-Präfix" };
  return { allowed: true };
}

/** Grobprüfung am Namen – fängt offensichtlich interne Ziele vor dem DNS ab. */
function hostNameAllowed(host) {
  const h = normalizeHost(host);
  if (!h) return { allowed: false, reason: "kein Host" };
  if (BLOCKED_NAMES.includes(h)) return { allowed: false, reason: `Name ${h} ist gesperrt` };
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return { allowed: false, reason: `interne Endung in ${h}` };
  if (!h.includes(".")) return { allowed: false, reason: `${h} ist kein vollständiger Name` };
  // Numerische Ziele nie zulassen: dann greift keine Freigabe per Name.
  const asIp = ipAllowed(h);
  if (ipv4ToInt(h) !== null || h.includes(":")) {
    return asIp.allowed ? { allowed: false, reason: "IP-Adressen statt Namen sind nicht zugelassen" } : asIp;
  }
  return { allowed: true };
}

/**
 * Vollständige Prüfung einer Ziel-URL, bevor eine Sitzung startet.
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
function checkTargetUrl(raw, allowList) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, reason: "Keine gültige URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, reason: `Protokoll ${u.protocol} ist nicht zugelassen` };
  }
  if (u.username || u.password) return { ok: false, reason: "URLs mit Zugangsdaten sind nicht zugelassen" };

  const byName = hostNameAllowed(u.hostname);
  if (!byName.allowed) return { ok: false, reason: byName.reason };
  if (!hostAllowed(u.hostname, allowList)) {
    return { ok: false, reason: `${u.hostname} ist nicht freigegeben` };
  }
  return { ok: true, url: u };
}

module.exports = {
  PRESETS, expandAllowList, hostAllowed, hostNameAllowed, ipAllowed, checkTargetUrl, normalizeHost,
};
