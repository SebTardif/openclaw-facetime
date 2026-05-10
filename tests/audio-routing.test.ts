import { describe, expect, it, vi } from "vitest";
import { captureCurrentDefaults, restoreDefaults, switchFaceTimeIO } from "../src/audio-routing.js";

describe("audio routing", () => {
  it("captures and switches input/output devices through SwitchAudioSource", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "BlackHole 16ch\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "BlackHole 16ch\n", stderr: "" })
      .mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(captureCurrentDefaults({ runCommandWithTimeout })).resolves.toEqual({
      inputDeviceUid: "Mac Mic",
      outputDeviceUid: "Mac Speakers",
    });
    await switchFaceTimeIO({ runCommandWithTimeout }, "BlackHole 16ch");
    await restoreDefaults(
      { runCommandWithTimeout },
      { inputDeviceUid: "Mac Mic", outputDeviceUid: "Mac Speakers" },
    );

    expect(runCommandWithTimeout.mock.calls.map(([argv]) => argv)).toEqual([
      ["/opt/homebrew/bin/SwitchAudioSource", "-c", "-t", "input"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-c", "-t", "output"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-s", "BlackHole 16ch", "-t", "input"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-s", "BlackHole 16ch", "-t", "output"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-c", "-t", "input"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-c", "-t", "output"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-s", "Mac Mic", "-t", "input"],
      ["/opt/homebrew/bin/SwitchAudioSource", "-s", "Mac Speakers", "-t", "output"],
    ]);
  });

  it("fails when SwitchAudioSource does not actually select BlackHole", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Mic\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Mac Speakers\n", stderr: "" });

    await expect(switchFaceTimeIO({ runCommandWithTimeout }, "BlackHole 16ch")).rejects.toThrow(
      "audio routing verification failed",
    );
  });
});
