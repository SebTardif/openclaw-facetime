import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

export type AudioDefaultsSnapshot = {
  inputDeviceUid?: string;
  outputDeviceUid?: string;
};

export type AudioRoutingDeps = {
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  logger?: RuntimeLogger;
};

const SWITCH_AUDIO_SOURCE_CANDIDATES = [
  "/opt/homebrew/bin/SwitchAudioSource",
  "/usr/local/bin/SwitchAudioSource",
  "SwitchAudioSource",
];
const COMMAND_TIMEOUT_MS = 5_000;

function readCommandOutput(result: Awaited<ReturnType<AudioRoutingDeps["runCommandWithTimeout"]>>) {
  return `${result.stdout ?? ""}`.trim();
}

async function runSwitchAudioSource(
  deps: AudioRoutingDeps,
  args: string[],
): Promise<Awaited<ReturnType<AudioRoutingDeps["runCommandWithTimeout"]>>> {
  let lastResult: Awaited<ReturnType<AudioRoutingDeps["runCommandWithTimeout"]>> | undefined;
  for (const command of SWITCH_AUDIO_SOURCE_CANDIDATES) {
    const result = await deps.runCommandWithTimeout([command, ...args], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    lastResult = result;
    if (result.code === 0 || !/ENOENT/i.test(`${result.stderr ?? ""}`)) {
      return result;
    }
  }
  if (lastResult) {
    return lastResult;
  }
  throw new Error("SwitchAudioSource command list is empty");
}

async function currentDevice(deps: AudioRoutingDeps, type: "input" | "output") {
  const result = await runSwitchAudioSource(deps, ["-c", "-t", type]);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `SwitchAudioSource -c -t ${type} failed`);
  }
  return readCommandOutput(result) || undefined;
}

export async function listAudioDevices(deps: AudioRoutingDeps, type: "input" | "output") {
  const result = await runSwitchAudioSource(deps, ["-a", "-t", type]);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `SwitchAudioSource -a -t ${type} failed`);
  }
  return `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function setDevice(deps: AudioRoutingDeps, type: "input" | "output", device: string) {
  const result = await runSwitchAudioSource(deps, ["-s", device, "-t", type]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || `SwitchAudioSource -s ${device} -t ${type} failed`,
    );
  }
}

export async function captureCurrentDefaults(
  deps: AudioRoutingDeps,
): Promise<AudioDefaultsSnapshot> {
  const [inputDeviceUid, outputDeviceUid] = await Promise.all([
    currentDevice(deps, "input"),
    currentDevice(deps, "output"),
  ]);
  return { inputDeviceUid, outputDeviceUid };
}

function normalizeDeviceName(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export async function switchFaceTimeIO(deps: AudioRoutingDeps, targetDeviceUid: string) {
  await setDevice(deps, "input", targetDeviceUid);
  await setDevice(deps, "output", targetDeviceUid);
  const selected = await captureCurrentDefaults(deps);
  const expected = normalizeDeviceName(targetDeviceUid);
  const inputMatches = normalizeDeviceName(selected.inputDeviceUid) === expected;
  const outputMatches = normalizeDeviceName(selected.outputDeviceUid) === expected;
  if (!inputMatches || !outputMatches) {
    throw new Error(
      `audio routing verification failed: input=${selected.inputDeviceUid ?? "unknown"}, output=${
        selected.outputDeviceUid ?? "unknown"
      }, expected=${targetDeviceUid}`,
    );
  }
  deps.logger?.info?.(
    `[facetime] audio routed to ${targetDeviceUid} (input=${selected.inputDeviceUid}, output=${selected.outputDeviceUid})`,
  );
  return selected;
}

export async function restoreDefaults(deps: AudioRoutingDeps, snapshot: AudioDefaultsSnapshot) {
  const errors: string[] = [];
  if (snapshot.inputDeviceUid) {
    await setDevice(deps, "input", snapshot.inputDeviceUid).catch((error: Error) => {
      errors.push(error.message);
    });
  }
  if (snapshot.outputDeviceUid) {
    await setDevice(deps, "output", snapshot.outputDeviceUid).catch((error: Error) => {
      errors.push(error.message);
    });
  }
  if (errors.length) {
    deps.logger?.warn(`[facetime] audio defaults restore failed: ${errors.join("; ")}`);
  }
}

export async function withFaceTimeAudioRouting<T>(
  deps: AudioRoutingDeps,
  params: {
    targetDeviceUid: string;
    saveAndRestoreDefaults: boolean;
    run: () => Promise<T>;
  },
): Promise<T> {
  const snapshot = params.saveAndRestoreDefaults ? await captureCurrentDefaults(deps) : {};
  await switchFaceTimeIO(deps, params.targetDeviceUid);
  try {
    return await params.run();
  } finally {
    if (params.saveAndRestoreDefaults) {
      await restoreDefaults(deps, snapshot);
    }
  }
}
