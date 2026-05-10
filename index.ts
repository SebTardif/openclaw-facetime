import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createFaceTimeRuntime, type FaceTimeRuntime } from "./runtime-entry.js";
import {
  resolveFaceTimeConfig,
  validateFaceTimeConfig,
  type FaceTimeConfig,
} from "./src/config.js";

const faceTimeConfigSchema = {
  parse(value: unknown): FaceTimeConfig {
    return resolveFaceTimeConfig(value);
  },
  uiHints: {
    enabled: { label: "Enable FaceTime Voice" },
    helperHost: { label: "Helper Host", advanced: true },
    helperPort: { label: "Helper Port", advanced: true },
    whitelistHandles: { label: "Allowed FaceTime Handles" },
    "audio.blackholeDeviceUid": { label: "BlackHole Device", advanced: true },
    "audio.sampleRateHz": { label: "Audio Sample Rate", advanced: true },
    "audio.saveAndRestoreDefaults": { label: "Restore Audio Defaults", advanced: true },
    "realtime.provider": { label: "Realtime Provider", advanced: true },
    "realtime.model": { label: "Realtime Model", advanced: true },
    "realtime.voice": { label: "Realtime Voice", advanced: true },
    "realtime.sessionKey": { label: "Lobster Session Key", advanced: true },
    "realtime.toolPolicy": { label: "Tool Policy", advanced: true },
  },
};

let runtimePromise: Promise<FaceTimeRuntime> | undefined;
let runtime: FaceTimeRuntime | undefined;

export default definePluginEntry({
  id: "facetime",
  name: "FaceTime",
  description: "Private FaceTime realtime voice carrier for Lobster",
  configSchema: faceTimeConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveFaceTimeConfig(api.pluginConfig);
    const validation = validateFaceTimeConfig(config);

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("facetime disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) {
        return runtime;
      }
      runtimePromise ??= createFaceTimeRuntime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
      });
      runtime = await runtimePromise;
      return runtime;
    };

    api.registerGatewayMethod(
      "facetime.status",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.status());
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "facetime.testAudio",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const phrase =
            params && typeof params === "object" && "phrase" in params
              ? (params as { phrase?: unknown }).phrase
              : undefined;
          respond(true, { ok: true, ...(await rt.testAudio({ phrase })) });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "facetime.hangup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const callUUID =
            params && typeof params === "object" && "callUUID" in params
              ? (params as { callUUID?: unknown }).callUUID
              : undefined;
          respond(true, { ok: true, ...(await rt.hangup({ callUUID })) });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.write" },
    );

    void ensureRuntime().catch((error) => {
      api.logger.warn(`[facetime] startup skipped: ${formatErrorMessage(error)}`);
      runtimePromise = undefined;
      runtime = undefined;
    });
  },
});
