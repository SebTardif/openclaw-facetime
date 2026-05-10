import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  captureCurrentDefaults,
  restoreDefaults,
  switchFaceTimeIO,
  type AudioDefaultsSnapshot,
} from "./audio-routing.js";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isWhitelistedFaceTimeCall,
  normalizeFaceTimeCallEvent,
  normalizeFaceTimeHandle,
  normalizeFaceTimeHandleCandidates,
  type FaceTimeCallStatusEvent,
} from "./call-events.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig, type FaceTimeConfig } from "./config.js";
import { formatErrorMessage } from "./errors.js";
import { prepareFaceTimeCallAudio } from "./facetime-ui.js";
import { FaceTimeHelperSocketServer } from "./helper-rpc.js";
import { startFaceTimeTalkDriver, type FaceTimeTalkDriver } from "./talk-driver.js";
import { playFaceTimeTestAudio } from "./test-audio.js";

type ActiveFaceTimeCall = {
  callUUID: string;
  handle?: string;
  audioDefaults?: AudioDefaultsSnapshot;
  audioRouted: boolean;
  audioDevices?: AudioDefaultsSnapshot;
  lastRoutingError?: string;
  talk?: FaceTimeTalkDriver;
};

export type FaceTimeRuntimeStatus = {
  enabled: true;
  helperConnected: boolean;
  currentAudioDefaults?: AudioDefaultsSnapshot;
  currentAudioError?: string;
  calls: Array<{
    callUUID: string;
    handle?: string;
    realtimeActive: boolean;
    audioRouted: boolean;
    audioDevices?: AudioDefaultsSnapshot;
    lastRoutingError?: string;
  }>;
};

export type FaceTimeRuntime = {
  config: FaceTimeConfig;
  status(): Promise<FaceTimeRuntimeStatus>;
  hangup(params?: { callUUID?: unknown }): Promise<{ callUUID: string }>;
  testAudio(params?: { phrase?: unknown }): Promise<{ phrase: string; deviceName: string }>;
  stop(): Promise<void>;
};

function readCallUUID(event: FaceTimeCallStatusEvent): string {
  return String(event.data.call_uuid);
}

export async function createFaceTimeRuntime(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): Promise<FaceTimeRuntime> {
  const config = resolveFaceTimeConfig(params.config);
  if (!config.enabled) {
    throw new Error("facetime disabled in plugin config");
  }
  const validation = validateFaceTimeConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid facetime config: ${validation.errors.join("; ")}`);
  }

  const calls = new Map<string, ActiveFaceTimeCall>();
  let stopping = false;
  const helper = new FaceTimeHelperSocketServer({
    host: config.helperHost,
    port: config.helperPort,
    logger: params.logger,
    onMessage(message) {
      const event = normalizeFaceTimeCallEvent(message);
      if (event) {
        void handleCallEvent(event);
      }
    },
  });

  const restoreCallAudio = async (call: ActiveFaceTimeCall) => {
    if (call.audioDefaults && config.audio.saveAndRestoreDefaults) {
      await restoreDefaults(
        {
          runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
          logger: params.logger,
        },
        call.audioDefaults,
      );
      call.audioDefaults = undefined;
    }
  };

  const routeCallAudio = async (
    call: ActiveFaceTimeCall,
    options: { prepareFaceTimeUi: boolean; unmute: boolean },
  ) => {
    const audioDeps = {
      runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
      logger: params.logger,
    };
    try {
      if (!call.audioDefaults && config.audio.saveAndRestoreDefaults) {
        call.audioDefaults = await captureCurrentDefaults(audioDeps);
      }
      call.audioDevices = await switchFaceTimeIO(audioDeps, config.audio.blackholeDeviceUid);
      call.audioRouted = true;
      call.lastRoutingError = undefined;
    } catch (error) {
      call.audioRouted = false;
      call.lastRoutingError = formatErrorMessage(error);
      throw error;
    }
    if (options.unmute) {
      await helper.setMuted(call.callUUID, false).catch((error: Error) => {
        params.logger.warn(
          `[facetime] helper failed to unmute call ${call.callUUID}: ${formatErrorMessage(error)}`,
        );
      });
    }
    if (options.prepareFaceTimeUi) {
      await prepareFaceTimeCallAudio(
        {
          runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
          logger: params.logger,
        },
        {
          blackholeDeviceName: config.audio.blackholeDeviceUid,
          unmute: options.unmute,
        },
      ).catch((error: Error) => {
        params.logger.warn(
          `[facetime] FaceTime UI audio preparation failed: ${formatErrorMessage(error)}`,
        );
      });
    }
  };

  const routeStandaloneAudio = async () => {
    await switchFaceTimeIO(
      {
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        logger: params.logger,
      },
      config.audio.blackholeDeviceUid,
    );
  };

  const closeCall = async (callUUID: string, reason: string) => {
    const call = calls.get(callUUID);
    if (!call) {
      return;
    }
    calls.delete(callUUID);
    await call.talk?.close(reason).catch((error: Error) => {
      params.logger.debug?.(
        `[facetime] talk close ignored for ${callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    await restoreCallAudio(call);
    call.audioRouted = false;
    call.audioDevices = undefined;
    params.logger.info(`[facetime] call closed: ${callUUID} (${reason})`);
  };

  const answerIncomingCall = async (event: FaceTimeCallStatusEvent) => {
    const callUUID = readCallUUID(event);
    const existing = calls.get(callUUID);
    if (existing) {
      return;
    }
    const handle = normalizeFaceTimeHandle(event.data.handle);
    const call: ActiveFaceTimeCall = { callUUID, handle, audioRouted: false };
    calls.set(callUUID, call);
    try {
      await routeCallAudio(call, { prepareFaceTimeUi: false, unmute: false });
      await helper.answerCall(callUUID);
      params.logger.info(
        `[facetime] answered whitelisted FaceTime call: ${callUUID} from ${handle ?? "unknown"}`,
      );
    } catch (error) {
      params.logger.warn(
        `[facetime] failed to answer FaceTime call ${callUUID}: ${formatErrorMessage(error)}`,
      );
      await closeCall(callUUID, "answer-failed");
    }
  };

  const activateCall = async (event: FaceTimeCallStatusEvent) => {
    const callUUID = readCallUUID(event);
    let call = calls.get(callUUID);
    if (!call) {
      call = { callUUID, handle: normalizeFaceTimeHandle(event.data.handle), audioRouted: false };
      calls.set(callUUID, call);
    }
    if (call.talk) {
      return;
    }
    try {
      await routeCallAudio(call, {
        prepareFaceTimeUi: true,
        unmute: event.data.is_sending_audio === false,
      });
      call.talk = await startFaceTimeTalkDriver({
        config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        callUUID,
      });
      params.logger.info(`[facetime] realtime talk session active: ${callUUID}`);
    } catch (error) {
      params.logger.warn(
        `[facetime] failed to start realtime talk for ${callUUID}: ${formatErrorMessage(error)}`,
      );
      await closeCall(callUUID, "talk-start-failed");
    }
  };

  const handleCallEvent = async (event: FaceTimeCallStatusEvent) => {
    if (stopping) {
      return;
    }
    const callUUID = readCallUUID(event);
    const handleForLog =
      normalizeFaceTimeHandleCandidates(event.data.handle).join(", ") || "unknown";
    if (isIncomingRingingCall(event)) {
      if (isWhitelistedFaceTimeCall({ event, whitelistHandles: config.whitelistHandles })) {
        await answerIncomingCall(event);
      } else {
        params.logger.info(
          `[facetime] ignored non-whitelisted FaceTime call: ${callUUID} handle=${handleForLog}`,
        );
      }
      return;
    }
    if (isActiveCall(event)) {
      if (
        !calls.has(callUUID) &&
        !isWhitelistedFaceTimeCall({ event, whitelistHandles: config.whitelistHandles })
      ) {
        params.logger.info(
          `[facetime] ignored active non-whitelisted FaceTime call: ${callUUID} handle=${handleForLog}`,
        );
        return;
      }
      await activateCall(event);
      return;
    }
    if (isEndedCall(event)) {
      await closeCall(callUUID, `status-${event.data.call_status}`);
    }
  };

  await helper.start();
  params.logger.info(
    `[facetime] listening for FaceTime helper events on ${config.helperHost}:${config.helperPort}`,
  );

  return {
    config,
    async status() {
      let currentAudioDefaults: AudioDefaultsSnapshot | undefined;
      let currentAudioError: string | undefined;
      try {
        currentAudioDefaults = await captureCurrentDefaults({
          runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
          logger: params.logger,
        });
      } catch (error) {
        currentAudioError = formatErrorMessage(error);
      }
      return {
        enabled: true,
        helperConnected: helper.connectedSockets > 0,
        currentAudioDefaults,
        currentAudioError,
        calls: [...calls.values()].map((call) => ({
          callUUID: call.callUUID,
          handle: call.handle,
          realtimeActive: Boolean(call.talk),
          audioRouted: call.audioRouted,
          audioDevices: call.audioDevices,
          lastRoutingError: call.lastRoutingError,
        })),
      };
    },
    async hangup(hangupParams) {
      const requestedCallUUID =
        typeof hangupParams?.callUUID === "string" && hangupParams.callUUID.trim()
          ? hangupParams.callUUID.trim()
          : undefined;
      const call = requestedCallUUID
        ? calls.get(requestedCallUUID)
        : ([...calls.values()].find((candidate) => candidate.talk) ?? [...calls.values()][0]);
      if (!call) {
        throw new Error("no active FaceTime call to hang up");
      }
      await helper.leaveCall(call.callUUID);
      await closeCall(call.callUUID, "operator-hangup");
      return { callUUID: call.callUUID };
    },
    async testAudio(testParams) {
      const activeCall = [...calls.values()].find((call) => call.talk) ?? [...calls.values()][0];
      let standaloneDefaults: AudioDefaultsSnapshot | undefined;
      try {
        if (activeCall) {
          await routeCallAudio(activeCall, { prepareFaceTimeUi: true, unmute: true });
        } else {
          if (config.audio.saveAndRestoreDefaults) {
            standaloneDefaults = await captureCurrentDefaults({
              runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
              logger: params.logger,
            });
          }
          await routeStandaloneAudio();
          await prepareFaceTimeCallAudio(
            {
              runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
              logger: params.logger,
            },
            {
              blackholeDeviceName: config.audio.blackholeDeviceUid,
              unmute: true,
            },
          ).catch((error: Error) => {
            params.logger.warn(
              `[facetime] FaceTime UI audio preparation failed: ${formatErrorMessage(error)}`,
            );
          });
        }
        return await playFaceTimeTestAudio(
          {
            runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
            logger: params.logger,
          },
          {
            deviceName: config.audio.blackholeDeviceUid,
            sampleRateHz: config.audio.sampleRateHz,
            phrase: testParams?.phrase,
          },
        );
      } finally {
        if (!activeCall && standaloneDefaults && config.audio.saveAndRestoreDefaults) {
          await restoreDefaults(
            {
              runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
              logger: params.logger,
            },
            standaloneDefaults,
          );
        }
      }
    },
    async stop() {
      stopping = true;
      for (const callUUID of [...calls.keys()]) {
        await closeCall(callUUID, "runtime-stop");
      }
      await helper.stop();
    },
  };
}
