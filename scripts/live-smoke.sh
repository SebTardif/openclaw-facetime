#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/live-smoke.sh [--test-audio] [--hangup]

Runs the non-calling FaceTime readiness checks, then prints current status.
If --test-audio is passed, sends the configured test phrase through the active
FaceTime call. If --hangup is passed, hangs up the active FaceTime call.
EOF
}

test_audio=false
hangup=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-audio)
      test_audio=true
      shift
      ;;
    --hangup)
      hangup=true
      shift
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

echo "== FaceTime preflight =="
openclaw gateway call facetime.preflight --json --timeout 20000

echo
echo "== FaceTime status =="
openclaw gateway call facetime.status --json --timeout 10000

if [[ "$test_audio" == true ]]; then
  echo
  echo "== FaceTime test audio =="
  openclaw gateway call facetime.testAudio \
    --params '{"phrase":"This is OpenClaw speaking through FaceTime."}' \
    --json \
    --timeout 30000

  echo
  echo "== FaceTime status after test audio =="
  openclaw gateway call facetime.status --json --timeout 10000
fi

if [[ "$hangup" == true ]]; then
  echo
  echo "== FaceTime hangup =="
  openclaw gateway call facetime.hangup --json --timeout 10000

  echo
  echo "== FaceTime status after hangup =="
  openclaw gateway call facetime.status --json --timeout 10000
fi

echo
echo "== sox processes =="
pgrep -fl sox || true
