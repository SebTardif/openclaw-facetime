import { describe, expect, it, vi } from "vitest";
import { playFaceTimeTestAudio } from "../src/test-audio.js";

describe("FaceTime test audio", () => {
  it("generates TTS and plays raw PCM through the FaceTime audio pump", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const pump = {
      writeOutputAudio: vi.fn(),
      clearOutputAudio: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const startPump = vi.fn().mockReturnValue(pump);
    const readFile = vi.fn().mockResolvedValue(Buffer.alloc(4800));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await playFaceTimeTestAudio(
      { runCommandWithTimeout, readFile, sleep, startPump },
      { deviceName: "BlackHole 16ch", sampleRateHz: 24000, phrase: "hello from test" },
    );

    expect(result).toEqual({ phrase: "hello from test", deviceName: "BlackHole 16ch" });
    const calls = runCommandWithTimeout.mock.calls.map(([argv]) => argv);
    expect(calls[0]?.slice(0, 4)).toEqual(["/usr/bin/say", "-v", "Samantha", "-o"]);
    expect(calls[0]?.[5]).toBe("hello from test");
    expect(calls[1]?.slice(0, 3)).toEqual(["/opt/homebrew/bin/sox", "-q", calls[0]?.[4]]);
    expect(calls[1]?.slice(3, 14)).toEqual([
      "-t",
      "raw",
      "-r",
      "24000",
      "-c",
      "1",
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-L",
    ]);
    expect(readFile).toHaveBeenCalledWith(calls[1]?.[14]);
    expect(startPump).toHaveBeenCalledWith({
      config: { deviceName: "BlackHole 16ch", sampleRateHz: 24000 },
      logger: console,
      onInputAudio: expect.any(Function),
    });
    expect(pump.writeOutputAudio).toHaveBeenCalledWith(Buffer.alloc(4800));
    expect(sleep).toHaveBeenCalledWith(350);
    expect(pump.stop).toHaveBeenCalled();
    expect(calls[2]).toEqual(["/bin/rm", "-f", calls[0]?.[4], calls[1]?.[14]]);
  });

  it("falls back to a default phrase and still cleans up on conversion failure", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "conversion failed" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await expect(
      playFaceTimeTestAudio(
        { runCommandWithTimeout },
        { deviceName: "BlackHole 16ch", sampleRateHz: 24000 },
      ),
    ).rejects.toThrow("conversion failed");

    const calls = runCommandWithTimeout.mock.calls.map(([argv]) => argv);
    expect(calls[0]?.[5]).toContain("OpenClaw");
    expect(calls[2]?.slice(0, 2)).toEqual(["/bin/rm", "-f"]);
  });
});
