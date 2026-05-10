import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

export type FaceTimeUiDeps = {
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  logger?: RuntimeLogger;
};

const COMMAND_TIMEOUT_MS = 8_000;

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildPrepareFaceTimeCallAudioScript(params: {
  blackholeDeviceName: string;
  unmute: boolean;
}) {
  const deviceName = appleScriptString(params.blackholeDeviceName);
  const unmuteScript = params.unmute
    ? `
my clickVideoMenuItemByName("Mute", 1, false)
`
    : "";

  return `
on dismissFaceTimeAlerts()
  tell application "System Events"
    tell process "FaceTime"
      repeat with faceTimeWindow in windows
        try
          if exists button "OK" of faceTimeWindow then
            click button "OK" of faceTimeWindow
            delay 0.15
          end if
        end try
      end repeat
    end tell
  end tell
end dismissFaceTimeAlerts

on clickVideoMenuItemByName(targetName, occurrenceIndex, failIfMissing)
  tell application "System Events"
    tell process "FaceTime"
      click menu bar item "Video" of menu bar 1
      delay 0.15
      set targetItems to menu items of menu 1 of menu bar item "Video" of menu bar 1 whose name is targetName
      set targetCount to count of targetItems
      if targetCount >= occurrenceIndex then
        click item occurrenceIndex of targetItems
        delay 0.15
      else
        key code 53
        if failIfMissing then error "missing FaceTime Video menu item: " & targetName
      end if
    end tell
  end tell
end clickVideoMenuItemByName

tell application "FaceTime" to activate
delay 0.2
my dismissFaceTimeAlerts()
${unmuteScript}
my clickVideoMenuItemByName(${deviceName}, 1, true)
my dismissFaceTimeAlerts()
my clickVideoMenuItemByName(${deviceName}, 2, true)
my dismissFaceTimeAlerts()
`;
}

export async function prepareFaceTimeCallAudio(
  deps: FaceTimeUiDeps,
  params: {
    blackholeDeviceName: string;
    unmute: boolean;
  },
) {
  const result = await deps.runCommandWithTimeout(
    ["osascript", "-e", buildPrepareFaceTimeCallAudioScript(params)],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to prepare FaceTime call audio controls",
    );
  }
}

