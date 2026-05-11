import { describe, expect, it, vi } from "vitest";
import { resolveFaceTimeConfig } from "../src/config.js";
import { runFaceTimePreflight } from "../src/preflight.js";

function runtimeWithCommands(runCommandWithTimeout: ReturnType<typeof vi.fn>) {
  return {
    system: { runCommandWithTimeout },
  } as any;
}

describe("FaceTime preflight", () => {
  it("passes when helper, audio devices, commands, FaceTime, and provider credentials are ready", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\nBlackHole 16ch\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\nBlackHole 16ch\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "sox: SoX v14.4.2\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "loopback rms=0.42\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "123\n", stderr: "" });

    const result = await runFaceTimePreflight({
      config: resolveFaceTimeConfig({
        whitelistHandles: ["omar@example.com"],
        realtime: { providers: { openai: { apiKey: { secretRef: "OPENAI_API_KEY" } } } },
      }),
      fullConfig: {} as any,
      runtime: runtimeWithCommands(runCommandWithTimeout),
      helperConnected: true,
    });

    expect(result.ok).toBe(true);
    expect(result.currentAudioDefaults).toEqual({
      inputDeviceUid: "Mac Mic",
      outputDeviceUid: "Mac Speakers",
    });
    expect(result.checks.map((check) => [check.id, check.ok])).toEqual([
      ["helper-connected", true],
      ["current-audio-defaults", true],
      ["blackhole-input", true],
      ["blackhole-output", true],
      ["sox", true],
      ["blackhole-loopback", true],
      ["facetime-running", true],
      ["realtime-provider", true],
    ]);
  });

  it("reports actionable failures without throwing", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\n", stderr: "" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "ENOENT" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "ENOENT" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "ENOENT" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "RMS     amplitude:     0.000015" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });

    const result = await runFaceTimePreflight({
      config: resolveFaceTimeConfig({ whitelistHandles: ["omar@example.com"] }),
      fullConfig: {} as any,
      runtime: runtimeWithCommands(runCommandWithTimeout),
      helperConnected: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual([
      "helper-connected",
      "blackhole-input",
      "blackhole-output",
      "sox",
      "blackhole-loopback",
      "facetime-running",
      "realtime-provider",
    ]);
    expect(result.checks.find((check) => check.id === "helper-connected")?.message).toContain(
      "no helper connected",
    );
  });
});
