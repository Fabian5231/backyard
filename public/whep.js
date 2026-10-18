// WHEP-Client (WebRTC-HTTP Egress Protocol) für die Browser-Wiedergabe.
//
// Eigene Datei, damit sich dieser Teil einzeln testen lässt – er ist der
// einzige Schritt, der von echtem WebRTC zwischen Server und Zuschauer abhängt.
"use strict";

window.BackyardWhep = (() => {
  /** Wartet, bis ICE fertig gesammelt hat – längstens `ms`. */
  function iceGatheringDone(pc, ms = 4000) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => pc.iceGatheringState === "complete" && finish();
      const timer = setTimeout(finish, ms);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /**
   * Holt Bild und Ton per WHEP und hängt sie an ein <video>-Element.
   *
   * Der Media-Server kennt den Pfad erst, wenn die Aufnahme sendet. Deshalb
   * mehrere Versuche statt eines einzelnen Fehlschlags. Es wird nicht getrickelt:
   * ein einziger Austausch mit vollständigem SDP ist hier einfacher und reicht.
   *
   * @param {object} opts
   * @param {string} opts.whepUrl      Endpunkt, der das SDP-Angebot annimmt
   * @param {object} [opts.headers]    zusätzliche Kopfzeilen (z. B. Sitzungs-Token)
   * @param {HTMLVideoElement} opts.video
   * @param {(text: string) => void} [opts.onStatus]
   * @param {number} [opts.attempts]
   * @returns {Promise<RTCPeerConnection>}
   */
  async function connect({ whepUrl, headers = {}, video, onStatus = () => {}, attempts = 6, retryDelay = 1500 }) {
    let lastError = "unbekannt";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Nach einem fehlgeschlagenen Austausch ist eine Verbindung nicht mehr
      // verwendbar – jeder Versuch bekommt eine neue.
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
      try {
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        const media = new MediaStream();
        pc.addEventListener("track", (event) => {
          media.addTrack(event.track);
          video.srcObject = media;
          video.play().catch(() => {});
        });

        await pc.setLocalDescription(await pc.createOffer());
        await iceGatheringDone(pc);

        const res = await fetch(whepUrl, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", ...headers },
          body: pc.localDescription.sdp,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`${res.status} ${text.slice(0, 200)}`);
        }
        await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
        return pc;
      } catch (err) {
        pc.close();
        lastError = err.message;
        if (attempt >= attempts) throw new Error(`Verbindung fehlgeschlagen: ${lastError}`);
        onStatus(`Warte auf das Bild aus dem Browser … (${attempt}/${attempts})`);
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
    throw new Error(`Verbindung fehlgeschlagen: ${lastError}`);
  }

  return { connect, iceGatheringDone };
})();
