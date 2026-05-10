#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/live-acceptance.sh [--wait-seconds N] [--phrase TEXT]

Runs the Phase 1 FaceTime live acceptance sequence with a user present.
The script does not place FaceTime calls. It waits for a whitelisted incoming
call, checks routing, sends test audio, captures realtime status snapshots,
and hangs up only after an explicit prompt.
EOF
}

wait_seconds=180
phrase="This is OpenClaw speaking through FaceTime."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-seconds)
      if [[ $# -lt 2 ]]; then
        echo "--wait-seconds requires a value" >&2
        usage >&2
        exit 2
      fi
      wait_seconds="${2:-}"
      shift 2
      ;;
    --phrase)
      if [[ $# -lt 2 ]]; then
        echo "--phrase requires a value" >&2
        usage >&2
        exit 2
      fi
      phrase="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]] || [[ "$wait_seconds" -lt 1 ]]; then
  echo "--wait-seconds must be a positive integer" >&2
  exit 2
fi

log_dir="${TMPDIR:-/tmp}/openclaw-facetime-acceptance"
mkdir -p "$log_dir"
log_file="${log_dir}/$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$log_file") 2>&1

gateway_call() {
  openclaw gateway call "$@" --json --timeout 30000
}

read_status() {
  gateway_call facetime.status
}

status_has_call() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    process.exit(Array.isArray(status.calls) && status.calls.length > 0 ? 0 : 1);
  '
}

status_has_routed_blackhole_call() {
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const calls = Array.isArray(status.calls) ? status.calls : [];
    const ok = calls.some((call) => {
      const devices = call && typeof call === "object" ? call.audioDevices : undefined;
      return call.audioRouted === true
        && devices
        && String(devices.inputDeviceUid || "").includes("BlackHole")
        && String(devices.outputDeviceUid || "").includes("BlackHole");
    });
    process.exit(ok ? 0 : 1);
  '
}

status_has_event_type() {
  local pattern="$1"
  node -e '
    const fs = require("node:fs");
    const pattern = new RegExp(process.argv[1]);
    const status = JSON.parse(fs.readFileSync(0, "utf8"));
    const calls = Array.isArray(status.calls) ? status.calls : [];
    const events = calls.flatMap((call) => Array.isArray(call.recentTalkEvents) ? call.recentTalkEvents : []);
    process.exit(events.some((event) => pattern.test(String(event.type || ""))) ? 0 : 1);
  ' "$pattern"
}

require_yes() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Acceptance stopped: $prompt" >&2
      exit 1
      ;;
  esac
}

echo "Log: $log_file"
echo
echo "== Preflight =="
gateway_call facetime.preflight

echo
echo "== Initial status =="
status_json="$(read_status)"
printf '%s\n' "$status_json"

echo
echo "== Initial sox processes =="
pgrep -fl sox || true

echo
echo "Place the whitelisted FaceTime call from the iPhone now."
echo "This script will wait up to ${wait_seconds}s for facetime.status to report a BlackHole-routed active call."
deadline=$((SECONDS + wait_seconds))
call_seen=false
while true; do
  status_json="$(read_status)"
  if status_has_call <<<"$status_json"; then
    if [[ "$call_seen" == false ]]; then
      echo "FaceTime call detected; waiting for BlackHole audio routing."
      call_seen=true
    fi
    if status_has_routed_blackhole_call <<<"$status_json"; then
      break
    fi
  fi
  if (( SECONDS >= deadline )); then
    if [[ "$call_seen" == true ]]; then
      echo "Timed out waiting for the active FaceTime call to route through BlackHole." >&2
    else
      echo "Timed out waiting for an active FaceTime call." >&2
    fi
    printf '%s\n' "$status_json" >&2
    exit 1
  fi
  sleep 2
done

echo
echo "== Active call status =="
printf '%s\n' "$status_json"
echo "Audio routing check passed: active call is routed through BlackHole."

echo
echo "== Test audio =="
gateway_call facetime.testAudio --params "$(node -e 'console.log(JSON.stringify({ phrase: process.argv[1] }))' "$phrase")"
require_yes "Did the iPhone hear the FaceTime test phrase clearly?"

echo
echo "Speak into the iPhone and wait for Lobster to respond, then press Enter."
read -r _
status_json="$(read_status)"
echo "== Realtime speech status =="
printf '%s\n' "$status_json"
if ! status_has_event_type 'transcript|output\.audio\.delta' <<<"$status_json"; then
  echo "Warning: recentTalkEvents did not show transcript or output.audio.delta in the current status window." >&2
fi
require_yes "Did Lobster respond contextually to iPhone speech?"

echo
echo "Ask a tool-backed question now, then press Enter after Lobster answers."
read -r _
status_json="$(read_status)"
echo "== Tool-use status =="
printf '%s\n' "$status_json"
if ! status_has_event_type 'tool\.(call|result)' <<<"$status_json"; then
  echo "Warning: recentTalkEvents did not show tool.call/tool.result in the current status window." >&2
fi
require_yes "Did the tool-backed answer complete correctly?"

echo
echo "Talk over Lobster mid-sentence to test barge-in, then press Enter."
read -r _
status_json="$(read_status)"
echo "== Barge-in status =="
printf '%s\n' "$status_json"
require_yes "Did Lobster stop speaking promptly when interrupted?"

echo
echo "The script can now hang up through OpenClaw."
require_yes "Hang up the active FaceTime call now?"

echo
echo "== Hangup =="
gateway_call facetime.hangup

sleep 2

echo
echo "== Final status =="
read_status

echo
echo "== Final sox processes =="
pgrep -fl sox || true

echo
echo "== Final running tasks =="
openclaw tasks list --status running

echo
echo "Acceptance log saved to $log_file"
