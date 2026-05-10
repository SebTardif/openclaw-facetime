# OpenClaw FaceTime

Standalone FaceTime voice carrier for OpenClaw/Lobster.

This repository contains:

- `@openclaw/facetime` OpenClaw plugin at the repo root.
- `helper/FaceTimeHelper.xcodeproj`, a standalone FaceTime-injected helper bundle that connects directly to the plugin socket.

Runtime path:

```text
FaceTime.app -> FaceTimeHelper.dylib -> localhost:45670+(uid-501) -> OpenClaw facetime plugin
```

No external server or app is required.

## Development Checks

From this repo, after installing dependencies:

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Helper Build

The helper requires full Xcode, CocoaPods, SoX, BlackHole, and switchaudio-osx:

```bash
brew install cocoapods sox switchaudio-osx
```

Install BlackHole 16ch separately and reboot if macOS asks for it. Then install helper pods:

```bash
cd helper
pod install
open FaceTimeHelper.xcworkspace
```

For a command-line local macOS build:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -workspace FaceTimeHelper.xcworkspace -scheme FaceTimeHelper -configuration Debug ARCHS=arm64e build
```

FaceTime.app itself is Mac Catalyst on current macOS. For live injection into FaceTime.app, build and stage the Mac Catalyst helper:

```bash
pnpm build:helper:macabi
```

The helper connects to `localhost` on `45670 + uid - 501`, matching the plugin default `helperPort`.

## Live Test

Start OpenClaw with the plugin installed and enabled:

```bash
openclaw gateway run --verbose
```

Make sure Developer Tools attach permission is enabled from an interactive Terminal:

```bash
sudo /usr/sbin/DevToolsSecurity -enable
```

Open FaceTime, then inject the helper:

```bash
pnpm build:helper:macabi
pnpm inject:helper
```

On current macOS, LLDB attach into FaceTime must be run from an interactive Terminal. A non-interactive shell may fail with `cannot get permission to debug processes`.

From non-interactive agent sessions, use this wrapper to open Terminal and run the same injection command interactively:

```bash
pnpm inject:helper:terminal
```

After injection, verify that the plugin sees the helper before placing a call:

```bash
openclaw gateway call facetime.status --json
```

Expected idle output includes:

```json
{
  "enabled": true,
  "helperConnected": true,
  "currentAudioDefaults": {
    "inputDeviceUid": "MacBook Air Microphone",
    "outputDeviceUid": "MacBook Air Speakers"
  },
  "calls": []
}
```

If `helperConnected` is `false`, the gateway is listening but FaceTime has not loaded `FaceTimeHelper.dylib`. Re-run `pnpm inject:helper` from an interactive Terminal after opening FaceTime.

The expected path is:

```text
FaceTime helper connects -> facetime plugin logs helper events -> whitelisted incoming call is answered -> audio routes through BlackHole -> realtime bridge starts
```

Outgoing FaceTime audio URLs currently still require the user to click the FaceTime call/join prompt on the Lobster Mac. During an active call, the plugin switches the system default input/output to BlackHole and best-effort selects `BlackHole 16ch` in FaceTime's own Video menu for Microphone and Output. If audio is still silent, check that the FaceTime call HUD microphone button is not muted.

To isolate the FaceTime audio carrier without starting a realtime model session, use the test audio method while the call is connected:

```bash
openclaw gateway call facetime.testAudio --params '{"phrase":"This is OpenClaw speaking through FaceTime."}' --json
```

During a call, `facetime.status` reports per-call `audioRouted`, `audioDevices`, and `lastRoutingError`. `audioRouted` must be `true` and both devices should be `BlackHole 16ch` before testing realtime speech.

To hang up the active FaceTime call from OpenClaw during testing:

```bash
openclaw gateway call facetime.hangup --json
```

To target a specific call:

```bash
openclaw gateway call facetime.hangup --params '{"callUUID":"..."}' --json
```
