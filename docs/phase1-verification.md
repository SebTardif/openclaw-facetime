# Phase 1 Verification

Status as of 2026-05-10 09:22 PDT: implementation and non-call readiness are complete; live call acceptance is still unverified.

## Current Evidence

- Repository: `/Users/lobster/GitHub/openclaw-facetime`
- Implementation commit verified by CI: `e8eaf48`
- Docs refresh commit verified by CI: `2a3f349`
- Latest successful CI run observed during audit: `25633733315`
- Local live preflight: `ok: true`
- Helper: connected
- FaceTime.app: running
- Audio defaults: `MacBook Air Microphone` input, `MacBook Air Speakers` output
- BlackHole: `BlackHole 16ch` visible as both input and output
- Realtime provider: `openai:gpt-realtime-2`
- Active calls: none
- Leftover `sox` processes: none
- OpenClaw background tasks: `0 queued`, `0 running`, `0 issues`

## Prompt-To-Artifact Checklist

| Requirement | Evidence | Status |
| --- | --- | --- |
| Standalone repo named `openclaw-facetime` | Git repo at `/Users/lobster/GitHub/openclaw-facetime`, remote `openclaw/openclaw-facetime` | Done |
| No BlueBubbles dependency | Helper and plugin live in this repo; README says no external server/app is required | Done |
| Extension id/name `facetime` / `FaceTime` | `openclaw.plugin.json`, `index.ts` | Done |
| OpenAI key via SecretRef | Live preflight reports realtime provider credentials configured | Done |
| Whitelist includes Omar | Live config has `mailto:omar@shahine.com`, `omar@shahine.com`, `+12069106512` | Done |
| Helper socket ingestion | `helperConnected: true` from `facetime.preflight` | Done |
| Auto-answer wiring | `FaceTimeHelperSocketServer.answerCall`, incoming call handler in `src/runtime.ts` | Implemented, live verification pending |
| Audio routing through BlackHole | `src/audio-routing.ts`, preflight checks BlackHole input/output | Implemented, live verification pending |
| PCM pump | `src/audio-pump.ts`, tests cover spawn/write/clear/stop cleanup | Implemented, live verification pending |
| Realtime talk driver | `src/talk-driver.ts` uses OpenClaw realtime voice bridge with agent-consult | Implemented, live verification pending |
| Barge-in handling | `src/talk-driver.ts` clears output on `input_audio_buffer.speech_started` | Implemented, live verification pending |
| Operator hangup | `facetime.hangup`, helper `leave-call`, tests in `tests/helper-rpc.test.ts` | Done |
| Preflight before live test | `facetime.preflight`, `scripts/live-smoke.sh` | Done |
| Full live acceptance runner | `scripts/live-acceptance.sh` waits for a user-placed call and records the Phase 1 gates | Ready, live verification pending |
| CI | GitHub Actions run `25633733315` ran `pnpm typecheck`, `pnpm test`, `bash -n scripts/*.sh`, and `pnpm build` | Passing |
| Idle task cleanup | `openclaw tasks list --status running` reports `0 queued`, `0 running`, `0 issues` | Done |

## Live Acceptance Gates

Run these only with the user present.

1. Preflight:

   ```bash
   scripts/live-smoke.sh
   ```

   Expected: `ok: true`, `calls: []`, no `sox` processes.

2. Auto-answer:

   From iPhone, FaceTime the whitelisted Apple ID.

   Expected: Mac answers within 2 rings. `facetime.status` shows one call.

3. Audio routing:

   ```bash
   openclaw gateway call facetime.status --json --timeout 10000
   ```

   Expected: active call has `audioRouted: true`, input/output devices are `BlackHole 16ch`.

4. Test audio:

   ```bash
   scripts/live-smoke.sh --test-audio
   ```

   Expected: iPhone hears "This is OpenClaw speaking through FaceTime."

5. Realtime speech:

   Speak into the iPhone.

   Expected: `facetime.status` active call includes recent talk events with `transcript.*` and `output.audio.delta`.

6. Tool use:

   Ask for a tool-backed answer, such as a calendar/status question.

   Expected: `recentTalkEvents` includes `tool.call` and `tool.result`.

7. Barge-in:

   Talk over Lobster mid-sentence.

   Expected: output cuts off quickly and status events continue.

8. Cleanup:

   ```bash
   scripts/live-smoke.sh --hangup
   pgrep -fl sox || true
   openclaw gateway call facetime.status --json --timeout 10000
   ```

   Expected: no calls, no `sox` processes, audio defaults restored to MacBook mic/speakers.

The same gates can be run as one guided pass with:

```bash
scripts/live-acceptance.sh
```
