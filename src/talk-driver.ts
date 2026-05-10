import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  createRealtimeVoiceBridgeSession,
  createTalkSessionController,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  recordTalkObservabilityEvent,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceToolCallEvent,
  type TalkEvent,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { startFaceTimeAudioPump, type FaceTimeAudioPump } from "./audio-pump.js";
import type { FaceTimeConfig } from "./config.js";
import { formatErrorMessage } from "./errors.js";

export type FaceTimeTalkDriver = {
  readonly callUUID: string;
  readonly recentTalkEvents: readonly TalkEvent[];
  close(reason?: string): Promise<void>;
};

type TranscriptEntry = { role: "user" | "assistant"; text: string };

const CONSULT_SYSTEM_PROMPT = [
  "You are Lobster's main agent being consulted from a private 1:1 FaceTime voice call.",
  "Act on behalf of Omar with normal memory and tool access.",
  "Return a concise, speakable answer suitable for realtime TTS.",
].join(" ");

function pushRecent(events: TalkEvent[], event: TalkEvent | undefined): void {
  if (!event) {
    return;
  }
  events.push(event);
  if (events.length > 40) {
    events.splice(0, events.length - 40);
  }
}

function agentIdFromSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (normalized.startsWith("agent:")) {
    return normalized.split(":")[1] || "main";
  }
  return "main";
}

async function resolveRealtimeProviderConfigs(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
}): Promise<Record<string, Record<string, unknown>>> {
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [providerId, providerConfig] of Object.entries(params.config.realtime.providers)) {
    const next = { ...providerConfig };
    if ("apiKey" in next) {
      const resolved = await resolveConfiguredSecretInputString({
        config: params.fullConfig,
        env: process.env,
        value: next.apiKey,
        path: `plugins.entries.facetime.config.realtime.providers.${providerId}.apiKey`,
      });
      if (resolved.value) {
        next.apiKey = resolved.value;
      }
    }
    providers[providerId] = next;
  }
  return providers;
}

export async function startFaceTimeTalkDriver(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  callUUID: string;
}): Promise<FaceTimeTalkDriver> {
  const providerConfigs = await resolveRealtimeProviderConfigs({
    config: params.config,
    fullConfig: params.fullConfig,
  });
  const resolved = resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: params.config.realtime.provider,
    providerConfigs: {
      ...providerConfigs,
      [params.config.realtime.provider]: {
        ...(providerConfigs[params.config.realtime.provider] ?? {}),
        voice: params.config.realtime.voice,
      },
    },
    cfg: params.fullConfig,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No realtime voice provider registered",
  });
  const talk = createTalkSessionController(
    {
      sessionId: `facetime:${params.callUUID}`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `facetime:${params.callUUID}:turn`,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let pump: FaceTimeAudioPump | undefined;

  const remember = (input: TalkEventInput) => pushRecent(recentTalkEvents, talk.emit(input));
  const ensureTurn = () => {
    const turn = talk.ensureTurn({ payload: { callUUID: params.callUUID } });
    pushRecent(recentTalkEvents, turn.event);
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string) => {
    pushRecent(recentTalkEvents, talk.finishOutputAudio({ payload: { reason } }));
  };
  const endTurn = (reason: string) => {
    const ended = talk.endTurn({ payload: { reason } });
    if (ended.ok) {
      pushRecent(recentTalkEvents, ended.event);
    }
  };
  const submitToolError = (event: RealtimeVoiceToolCallEvent, error: string) => {
    const callId = event.callId || event.itemId;
    remember({
      type: "tool.error",
      callId,
      payload: { name: event.name, error },
      final: true,
    });
    bridge?.submitToolResult(callId, { error });
  };
  const handleToolCall = (event: RealtimeVoiceToolCallEvent) => {
    const callId = event.callId || event.itemId;
    if (event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      submitToolError(event, `Tool "${event.name}" not available`);
      return;
    }
    const turnId = ensureTurn();
    remember({
      type: "tool.call",
      turnId,
      itemId: event.itemId,
      callId,
      payload: { name: event.name, args: event.args },
    });
    remember({
      type: "tool.progress",
      turnId,
      callId,
      payload: { name: event.name, status: "working" },
    });
    if (bridge?.bridge.supportsToolResultContinuation) {
      bridge.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("caller"), {
        willContinue: true,
      });
    }
    void consultRealtimeVoiceAgent({
      cfg: params.fullConfig,
      agentRuntime: params.runtime.agent,
      logger: params.logger,
      agentId: agentIdFromSessionKey(params.config.realtime.sessionKey),
      sessionKey: params.config.realtime.sessionKey,
      messageProvider: "facetime",
      lane: "facetime",
      runIdPrefix: `facetime:${params.callUUID}`,
      args: event.args,
      transcript,
      surface: "a private FaceTime call",
      userLabel: "Caller",
      assistantLabel: "Lobster",
      questionSourceLabel: "caller",
      toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
      extraSystemPrompt: CONSULT_SYSTEM_PROMPT,
    })
      .then((result) => {
        remember({
          type: "tool.result",
          turnId,
          callId,
          payload: { name: event.name, result },
          final: true,
        });
        bridge?.submitToolResult(callId, result);
      })
      .catch((error: Error) => {
        const message = formatErrorMessage(error);
        remember({
          type: "tool.error",
          turnId,
          callId,
          payload: { name: event.name, error: message },
          final: true,
        });
        bridge?.submitToolResult(callId, { error: message });
      });
  };

  remember({ type: "session.started", payload: { callUUID: params.callUUID } });
  pump = startFaceTimeAudioPump({
    config: {
      deviceName: params.config.audio.blackholeDeviceUid,
      sampleRateHz: params.config.audio.sampleRateHz,
    },
    logger: params.logger,
    onInputAudio(audio) {
      if (stopped) {
        return;
      }
      remember({
        type: "input.audio.delta",
        turnId: ensureTurn(),
        payload: { byteLength: audio.byteLength },
      });
      bridge?.sendAudio(audio);
    },
    onError(error) {
      remember({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
    },
  });
  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    providerConfig: resolved.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.config.realtime.instructions,
    autoRespondToAudio: true,
    triggerGreetingOnReady: true,
    initialGreetingInstructions: "Greet the caller briefly and say you are listening.",
    markStrategy: "ack-immediately",
    tools: resolveRealtimeVoiceAgentConsultTools(params.config.realtime.toolPolicy),
    audioSink: {
      isOpen: () => !stopped,
      sendAudio(audio) {
        const turnId = ensureTurn();
        pushRecent(
          recentTalkEvents,
          talk.startOutputAudio({ turnId, payload: { callUUID: params.callUUID } }).event,
        );
        remember({
          type: "output.audio.delta",
          turnId,
          payload: { byteLength: audio.byteLength },
        });
        pump?.writeOutputAudio(audio);
      },
      clearAudio() {
        pump?.clearOutputAudio();
        finishOutputAudio("clear");
      },
    },
    onTranscript(role, text, final) {
      const turnId = ensureTurn();
      remember({
        type:
          role === "assistant"
            ? final
              ? "output.text.done"
              : "output.text.delta"
            : final
              ? "transcript.done"
              : "transcript.delta",
        turnId,
        payload: role === "assistant" ? { text } : { role, text },
        final,
      });
      if (role === "user" && final) {
        remember({
          type: "input.audio.committed",
          turnId,
          payload: { callUUID: params.callUUID },
          final: true,
        });
      }
      if (final) {
        transcript.push({ role, text });
        if (transcript.length > 40) {
          transcript.splice(0, transcript.length - 40);
        }
      }
    },
    onEvent(event) {
      if (event.type === "input_audio_buffer.speech_started") {
        bridge?.handleBargeIn({ audioPlaybackActive: talk.outputAudioActive });
        if (talk.outputAudioActive) {
          pump?.clearOutputAudio();
          finishOutputAudio("barge-in");
        }
      } else if (event.type === "response.done") {
        finishOutputAudio("response.done");
        endTurn("response.done");
      } else if (event.type === "error") {
        remember({
          type: "session.error",
          payload: { message: event.detail ?? "Realtime provider error" },
          final: true,
        });
      }
    },
    onToolCall: handleToolCall,
    onReady() {
      remember({ type: "session.ready", payload: { callUUID: params.callUUID } });
    },
    onError(error) {
      remember({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      params.logger.warn(`[facetime] realtime bridge failed: ${formatErrorMessage(error)}`);
      void close("error");
    },
    onClose(reason) {
      finishOutputAudio(reason);
      remember({ type: "session.closed", payload: { reason }, final: true });
    },
  });

  const close = async (reason = "closed") => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[facetime] realtime bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    await pump?.stop();
    remember({ type: "session.closed", payload: { reason }, final: true });
  };

  await bridge.connect();
  return {
    callUUID: params.callUUID,
    get recentTalkEvents() {
      return recentTalkEvents;
    },
    close,
  };
}
