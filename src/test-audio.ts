import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { startFaceTimeAudioPump, type FaceTimeAudioPump } from "./audio-pump.js";
import { formatErrorMessage } from "./errors.js";

export type TestAudioDeps = {
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  logger?: RuntimeLogger;
  readFile?: typeof readFile;
  sleep?: (ms: number) => Promise<unknown>;
  startPump?: typeof startFaceTimeAudioPump;
};

const COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_TEST_PHRASE = "This is OpenClaw speaking through the FaceTime bridge.";
const SOX_CANDIDATES = ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"];

function normalizeTestPhrase(value: unknown) {
  const phrase = typeof value === "string" ? value.trim() : "";
  return phrase || DEFAULT_TEST_PHRASE;
}

async function runRequired(deps: TestAudioDeps, argv: string[]) {
  const result = await deps.runCommandWithTimeout(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${argv[0]} failed`);
  }
}

async function runSoxRequired(deps: TestAudioDeps, args: string[]) {
  let lastError: Error | undefined;
  for (const command of SOX_CANDIDATES) {
    const result = await deps.runCommandWithTimeout([command, ...args], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code === 0) {
      return;
    }
    lastError = new Error(result.stderr || result.stdout || `${command} failed`);
    if (!/ENOENT/i.test(`${result.stderr ?? ""}`)) {
      break;
    }
  }
  throw lastError ?? new Error("sox command list is empty");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function playFaceTimeTestAudio(
  deps: TestAudioDeps,
  params: {
    deviceName: string;
    sampleRateHz: number;
    phrase?: unknown;
  },
) {
  const phrase = normalizeTestPhrase(params.phrase);
  const audioPath = join(tmpdir(), `openclaw-facetime-test-${randomUUID()}.aiff`);
  const rawPath = join(tmpdir(), `openclaw-facetime-test-${randomUUID()}.raw`);
  try {
    await runRequired(deps, ["/usr/bin/say", "-v", "Samantha", "-o", audioPath, phrase]);
    await runSoxRequired(deps, [
      "-q",
      audioPath,
      "-t",
      "raw",
      "-r",
      String(params.sampleRateHz),
      "-c",
      "1",
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-L",
      rawPath,
    ]);
    const pcm = await (deps.readFile ?? readFile)(rawPath);
    const startPump = deps.startPump ?? startFaceTimeAudioPump;
    const pump: FaceTimeAudioPump = startPump({
      config: { deviceName: params.deviceName, sampleRateHz: params.sampleRateHz },
      logger: deps.logger ?? console,
      onInputAudio() {},
    });
    try {
      pump.writeOutputAudio(pcm);
      const durationMs = Math.ceil((pcm.byteLength / 2 / params.sampleRateHz) * 1000);
      await (deps.sleep ?? sleep)(Math.max(250, durationMs + 250));
    } finally {
      await pump.stop();
    }
  } finally {
    const cleanup = await deps.runCommandWithTimeout(["/bin/rm", "-f", audioPath, rawPath], {
      timeoutMs: 2_000,
    });
    if (cleanup.code !== 0) {
      deps.logger?.debug?.(
        `[facetime] test audio cleanup failed: ${formatErrorMessage(
          new Error(cleanup.stderr || cleanup.stdout || "rm failed"),
        )}`,
      );
    }
  }
  return { phrase, deviceName: params.deviceName };
}
