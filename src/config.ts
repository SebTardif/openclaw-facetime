import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export type FaceTimeConfig = {
  enabled: boolean;
  helperHost: string;
  helperPort: number;
  whitelistHandles: string[];
  audio: {
    blackholeDeviceUid: string;
    sampleRateHz: number;
    saveAndRestoreDefaults: boolean;
  };
  realtime: {
    provider: string;
    model: string;
    voice: string;
    sessionKey: string;
    brain: "agent-consult";
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    instructions?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

const DEFAULT_SAMPLE_RATE_HZ = 24_000;
const HELPER_BASE_PORT = 45670;

const DEFAULT_INSTRUCTIONS = [
  "You are Lobster speaking through a private 1:1 FaceTime call.",
  "Keep replies concise, natural, and useful for a hands-free voice conversation.",
  `Use ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} when the caller asks for memory, tools, current status, or work that should run in the main Lobster agent session.`,
].join(" ");

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolvePort(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function resolvePositiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveProviders(value: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(value);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, providerConfig] of Object.entries(raw)) {
    const id = normalizeOptionalString(key);
    if (id) {
      providers[id] = asRecord(providerConfig);
    }
  }
  return providers;
}

export function defaultFaceTimeHelperPort(
  uid = typeof process.getuid === "function" ? process.getuid() : 501,
) {
  return Math.min(Math.max(HELPER_BASE_PORT + uid - 501, HELPER_BASE_PORT), 65535);
}

export function resolveFaceTimeConfig(input: unknown): FaceTimeConfig {
  const raw = asRecord(input);
  const audio = asRecord(raw.audio);
  const realtime = asRecord(raw.realtime);
  const helperPort = resolvePort(raw.helperPort, defaultFaceTimeHelperPort());
  return {
    enabled: resolveBoolean(raw.enabled, true),
    helperHost: normalizeOptionalString(raw.helperHost) ?? "127.0.0.1",
    helperPort,
    whitelistHandles: resolveStringArray(raw.whitelistHandles),
    audio: {
      blackholeDeviceUid:
        normalizeOptionalString(audio.blackholeDeviceUid) ??
        normalizeOptionalString(audio.blackholeDeviceName) ??
        "BlackHole 16ch",
      sampleRateHz: resolvePositiveInteger(audio.sampleRateHz, DEFAULT_SAMPLE_RATE_HZ),
      saveAndRestoreDefaults: resolveBoolean(audio.saveAndRestoreDefaults, true),
    },
    realtime: {
      provider: normalizeOptionalString(realtime.provider) ?? "openai",
      model: normalizeOptionalString(realtime.model) ?? "gpt-realtime",
      voice: normalizeOptionalString(realtime.voice) ?? "cedar",
      sessionKey: normalizeOptionalString(realtime.sessionKey) ?? "main",
      brain: "agent-consult",
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy, "owner"),
      instructions: normalizeOptionalString(realtime.instructions) ?? DEFAULT_INSTRUCTIONS,
      providers: resolveProviders(realtime.providers),
    },
  };
}

export function validateFaceTimeConfig(config: FaceTimeConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!config.whitelistHandles.length) {
    errors.push("whitelistHandles must contain at least one allowed FaceTime handle");
  }
  if (process.platform !== "darwin") {
    errors.push("facetime requires macOS");
  }
  return { valid: errors.length === 0, errors };
}
