import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startFaceTimeAudioPump } from "../src/audio-pump.js";

class FakePipe extends EventEmitter {
  writes: Buffer[] = [];

  write(chunk: Buffer) {
    this.writes.push(chunk);
    return true;
  }
}

class FakeProcess extends EventEmitter {
  readonly stdin = new FakePipe();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  killed = false;

  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }
}

describe("FaceTime audio pump", () => {
  it("spawns CoreAudio sox input/output and forwards captured input audio", () => {
    const processes: FakeProcess[] = [];
    const spawn = vi.fn((_command, _args, _options) => {
      const proc = new FakeProcess();
      processes.push(proc);
      return proc;
    });
    const onInputAudio = vi.fn();

    startFaceTimeAudioPump({
      config: { deviceName: "BlackHole 16ch", sampleRateHz: 24000, bufferBytes: 2048 },
      logger: console,
      onInputAudio,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "-q",
      "--buffer",
      "2048",
      "-t",
      "coreaudio",
      "BlackHole 16ch",
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
      "-",
    ]);
    expect(spawn.mock.calls[0]?.[2]).toEqual({ stdio: ["ignore", "pipe", "pipe"] });
    expect(spawn.mock.calls[1]?.[1]).toContain("BlackHole 16ch");
    expect(spawn.mock.calls[1]?.[2]).toEqual({ stdio: ["pipe", "ignore", "pipe"] });

    processes[0]?.stdout.emit("data", Buffer.from([1, 2, 3]));
    processes[0]?.stdout.emit("data", Buffer.alloc(0));

    expect(onInputAudio).toHaveBeenCalledTimes(1);
    expect(onInputAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it("writes output audio, clears playback by replacing output, and stops active children", async () => {
    vi.useFakeTimers();
    try {
      const processes: FakeProcess[] = [];
      const spawn = vi.fn((_command, _args, _options) => {
        const proc = new FakeProcess();
        processes.push(proc);
        return proc;
      });
      const pump = startFaceTimeAudioPump({
        config: { deviceName: "BlackHole 16ch", sampleRateHz: 24000 },
        logger: console,
        onInputAudio() {},
        spawn,
      });

      const firstOutput = processes[1];
      pump.writeOutputAudio(Buffer.from([4, 5, 6]));
      expect(firstOutput?.stdin.writes).toEqual([Buffer.from([4, 5, 6])]);

      pump.clearOutputAudio();
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(firstOutput?.kills).toEqual(["SIGKILL"]);

      const input = processes[0];
      const secondOutput = processes[2];
      await pump.stop();
      expect(input?.kills).toEqual(["SIGTERM"]);
      expect(secondOutput?.kills).toEqual(["SIGTERM"]);

      vi.advanceTimersByTime(1000);
      expect(input?.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(secondOutput?.kills).toEqual(["SIGTERM", "SIGKILL"]);

      pump.writeOutputAudio(Buffer.from([7]));
      expect(secondOutput?.stdin.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
