import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  captureCurrentDefaults,
  listAudioDevices,
  type AudioDefaultsSnapshot,
} from "./audio-routing.js";
import type { FaceTimeConfig } from "./config.js";
import { formatErrorMessage } from "./errors.js";

type RunCommandWithTimeout = PluginRuntime["system"]["runCommandWithTimeout"];

export type FaceTimePreflightCheck = {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  message?: string;
};

export type FaceTimePreflightResult = {
  ok: boolean;
  helperConnected: boolean;
  currentAudioDefaults?: AudioDefaultsSnapshot;
  currentAudioError?: string;
  checks: FaceTimePreflightCheck[];
};

function normalizeDeviceName(value: string) {
  return value.trim().toLowerCase();
}

function firstLine(value: unknown) {
  return `${value ?? ""}`.trim().split(/\r?\n/)[0] || undefined;
}

function pushCheck(
  checks: FaceTimePreflightCheck[],
  check: Omit<FaceTimePreflightCheck, "required"> & { required?: boolean },
) {
  checks.push({ required: true, ...check });
}

async function checkCommandCandidates(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  checks: FaceTimePreflightCheck[];
  id: string;
  label: string;
  candidates: string[];
  args: string[];
  required?: boolean;
}) {
  let lastMessage: string | undefined;
  for (const command of params.candidates) {
    const result = await params.runCommandWithTimeout([command, ...params.args], {
      timeoutMs: 5_000,
    });
    if (result.code === 0) {
      pushCheck(params.checks, {
        id: params.id,
        label: params.label,
        ok: true,
        required: params.required,
        message: firstLine(result.stdout) ?? command,
      });
      return;
    }
    lastMessage = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `${command} failed`;
    if (!/ENOENT/i.test(`${result.stderr ?? ""}`)) {
      break;
    }
  }
  pushCheck(params.checks, {
    id: params.id,
    label: params.label,
    ok: false,
    required: params.required,
    message: lastMessage,
  });
}

function hasProviderCredential(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
}): boolean {
  const providerConfig = params.config.realtime.providers[params.config.realtime.provider];
  if (providerConfig && "apiKey" in providerConfig) {
    return true;
  }
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function runFaceTimePreflight(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger?: RuntimeLogger;
  helperConnected: boolean;
}): Promise<FaceTimePreflightResult> {
  const checks: FaceTimePreflightCheck[] = [];
  pushCheck(checks, {
    id: "helper-connected",
    label: "FaceTime helper socket",
    ok: params.helperConnected,
    message: params.helperConnected
      ? "helper connected"
      : `no helper connected on ${params.config.helperHost}:${params.config.helperPort}`,
  });

  let currentAudioDefaults: AudioDefaultsSnapshot | undefined;
  let currentAudioError: string | undefined;
  try {
    currentAudioDefaults = await captureCurrentDefaults({
      runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
      logger: params.logger,
    });
    pushCheck(checks, {
      id: "current-audio-defaults",
      label: "Current audio defaults",
      ok: true,
      message: `input=${currentAudioDefaults.inputDeviceUid ?? "unknown"}, output=${
        currentAudioDefaults.outputDeviceUid ?? "unknown"
      }`,
    });
  } catch (error) {
    currentAudioError = formatErrorMessage(error);
    pushCheck(checks, {
      id: "current-audio-defaults",
      label: "Current audio defaults",
      ok: false,
      message: currentAudioError,
    });
  }

  for (const type of ["input", "output"] as const) {
    try {
      const devices = await listAudioDevices(
        { runCommandWithTimeout: params.runtime.system.runCommandWithTimeout },
        type,
      );
      const target = normalizeDeviceName(params.config.audio.blackholeDeviceUid);
      const found = devices.some((device) => normalizeDeviceName(device) === target);
      pushCheck(checks, {
        id: `blackhole-${type}`,
        label: `BlackHole ${type} device`,
        ok: found,
        message: found
          ? params.config.audio.blackholeDeviceUid
          : `missing ${params.config.audio.blackholeDeviceUid}; found: ${devices.join(", ")}`,
      });
    } catch (error) {
      pushCheck(checks, {
        id: `blackhole-${type}`,
        label: `BlackHole ${type} device`,
        ok: false,
        message: formatErrorMessage(error),
      });
    }
  }

  await checkCommandCandidates({
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
    checks,
    id: "sox",
    label: "SoX command",
    candidates: ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"],
    args: ["--version"],
  });

  await checkCommandCandidates({
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
    checks,
    id: "facetime-running",
    label: "FaceTime.app process",
    candidates: ["/usr/bin/pgrep"],
    args: ["-x", "FaceTime"],
  });

  pushCheck(checks, {
    id: "realtime-provider",
    label: "Realtime provider credentials",
    ok: hasProviderCredential({ config: params.config, fullConfig: params.fullConfig }),
    message: `${params.config.realtime.provider}:${params.config.realtime.model}`,
  });

  return {
    ok: checks.every((check) => check.ok || !check.required),
    helperConnected: params.helperConnected,
    currentAudioDefaults,
    currentAudioError,
    checks,
  };
}
