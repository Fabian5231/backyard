#!/bin/bash
# Startet Audio-Server, Media-Server und Steuerdienst und beendet den Container,
# sobald eine der drei Komponenten wegfällt (restart: unless-stopped greift dann).
set -uo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

PULSE_SOCK="$XDG_RUNTIME_DIR/pulse.sock"

# PulseAudio mit -n: nur die Module, die wirklich gebraucht werden. Senken pro
# Sitzung lädt der Steuerdienst später per pactl nach.
# Wichtig: PULSE_SERVER darf beim Start des Daemons nicht gesetzt sein, sonst
# verweigert PulseAudio den Start ("refusing to start/autospawn").
env -u PULSE_SERVER pulseaudio -n \
  --daemonize=no --exit-idle-time=-1 --disallow-exit \
  --load="module-native-protocol-unix socket=$PULSE_SOCK auth-anonymous=1" \
  --log-target=stderr --log-level=warn &
PULSE_PID=$!
export PULSE_SERVER="unix:$PULSE_SOCK"

for _ in $(seq 1 50); do
  [ -S "$PULSE_SOCK" ] && break
  sleep 0.2
done
if ! pactl info >/dev/null 2>&1; then
  echo "FEHLER: PulseAudio ist nicht erreichbar." >&2
  exit 1
fi
echo "PulseAudio bereit ($PULSE_SOCK)"

if [ -z "${MTX_WEBRTCADDITIONALHOSTS:-}" ]; then
  echo "WARNUNG: MTX_WEBRTCADDITIONALHOSTS (BROWSER_PUBLIC_HOST) ist nicht gesetzt." >&2
  echo "         Der Zuschauer-Browser erhält dann nur die Container-IP als ICE-Kandidat" >&2
  echo "         und die WebRTC-Verbindung wird außerhalb des Docker-Netzes scheitern." >&2
fi

/usr/local/bin/mediamtx /app/mediamtx.yml &
MTX_PID=$!

node /app/service.js &
SVC_PID=$!

shutdown() {
  echo "Signal empfangen – beende Komponenten"
  kill -TERM "$SVC_PID" 2>/dev/null || true
  wait "$SVC_PID" 2>/dev/null || true
  kill -TERM "$MTX_PID" "$PULSE_PID" 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# Fällt eine Komponente aus, den Container beenden statt halb weiterzulaufen.
wait -n "$PULSE_PID" "$MTX_PID" "$SVC_PID"
echo "Eine Komponente wurde beendet – Container wird gestoppt" >&2
kill -TERM "$SVC_PID" "$MTX_PID" "$PULSE_PID" 2>/dev/null || true
sleep 2
exit 1
