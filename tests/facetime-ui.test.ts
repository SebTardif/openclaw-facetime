import { describe, expect, it, vi } from "vitest";
import { prepareFaceTimeCallAudio } from "../src/facetime-ui.js";

describe("FaceTime UI preparation", () => {
  it("selects BlackHole from FaceTime without toggling the mute menu item", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await prepareFaceTimeCallAudio(
      { runCommandWithTimeout },
      { blackholeDeviceName: 'BlackHole "16ch"', unmute: true },
    );
    await prepareFaceTimeCallAudio(
      { runCommandWithTimeout },
      { blackholeDeviceName: "BlackHole 16ch", unmute: false },
    );

    const firstScript = runCommandWithTimeout.mock.calls[0]?.[0][2] ?? "";
    const secondScript = runCommandWithTimeout.mock.calls[1]?.[0][2] ?? "";

    expect(runCommandWithTimeout.mock.calls.map(([argv]) => argv.slice(0, 2))).toEqual([
      ["osascript", "-e"],
      ["osascript", "-e"],
    ]);
    expect(firstScript).not.toContain('my clickVideoMenuItemByName("Mute", 1, false)');
    expect(firstScript).toContain('my clickVideoMenuItemByName("BlackHole \\"16ch\\"", 1, true)');
    expect(firstScript).toContain('my clickVideoMenuItemByName("BlackHole \\"16ch\\"", 2, true)');
    expect(secondScript).not.toContain('my clickVideoMenuItemByName("Mute", 1, false)');
  });

  it("reports osascript failures", async () => {
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "not authorized" });

    await expect(
      prepareFaceTimeCallAudio(
        { runCommandWithTimeout },
        { blackholeDeviceName: "BlackHole 16ch", unmute: false },
      ),
    ).rejects.toThrow("not authorized");
  });
});
