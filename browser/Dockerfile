# Browser-Wiedergabe: Chromium unter Xvfb, Aufnahme per ffmpeg, Ausgabe als WebRTC.
# Läuft ohne GPU und ohne privilegierten Container.
FROM node:22-bookworm-slim

ARG MEDIAMTX_VERSION=v1.21.2
ARG MEDIAMTX_SHA256=121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      xvfb \
      pulseaudio pulseaudio-utils \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      dumb-init ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Media-Server (WHEP/WebRTC) als einzelne statische Binärdatei, Prüfsumme fest.
RUN curl -fsSL -o /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
 && echo "${MEDIAMTX_SHA256}  /tmp/mediamtx.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
 && rm /tmp/mediamtx.tar.gz \
 && /usr/local/bin/mediamtx --version

# Chromium-Richtlinien als zusätzliche Absicherung (greifen unabhängig von den Startparametern).
COPY chromium-policies.json /etc/chromium/policies/managed/backyard.json

WORKDIR /app
COPY service.js mediamtx.yml ./
COPY lib ./lib
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# Unprivilegierter Nutzer. Die Chromium-Sandbox bleibt eingeschaltet; sie braucht
# nur unprivilegierte User-Namespaces, keine zusätzlichen Capabilities.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin backyard \
 && mkdir -p /tmp/.X11-unix /tmp/runtime \
 && chmod 1777 /tmp/.X11-unix \
 && chown backyard:backyard /tmp/runtime \
 && chmod +x /usr/local/bin/entrypoint.sh

USER backyard
ENV XDG_RUNTIME_DIR=/tmp/runtime \
    HOME=/home/backyard \
    BROWSER_CHROMIUM_PATH=/usr/bin/chromium \
    BROWSER_SERVICE_PORT=8090 \
    BROWSER_RTSP_PORT=8554 \
    BROWSER_WEBRTC_PORT=8889 \
    BROWSER_EGRESS_PORT=8081

# Nur der Steuerdienst (internes Netz) und der ICE-Port (von außen) werden gebraucht.
EXPOSE 8090 8189/udp 8189/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.BROWSER_SERVICE_PORT||8090)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
