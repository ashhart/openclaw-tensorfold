import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  API_KEY_ENV,
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  fetchModels,
  hasConfiguredModels,
  resolveBaseUrl,
} from "./models.js";
import { configureLocalNonInteractive, detectLocal, prepareDetected, runLocalSetup } from "./setup.js";

const LABEL = "TensorFold";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: LABEL,
  description: "TensorFold as a model provider: OpenClaw can start tensorfold serve on demand, or connect to a running server",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: LABEL,
      envVars: [API_KEY_ENV],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "TensorFold API key",
          hint: `A key from the server's key file, or any value for a server without keys (${DEFAULT_BASE_URL})`,
          optionKey: "tensorfoldApiKey",
          flagName: "--tensorfold-api-key",
          envVar: API_KEY_ENV,
          promptMessage: "TensorFold API key (any value if the server has no keys)",
          resolveDefaultModel: async ({ apiKey, config, signal }) => {
            const baseUrl = resolveBaseUrl(config, process.env);
            const models = await fetchModels({ baseUrl, apiKey, signal }).catch(() => []);
            return models[0] ? `${PROVIDER_ID}/${models[0].id}` : undefined;
          },
        }),
        {
          id: "local",
          label: "TensorFold on this computer",
          hint: "OpenClaw starts tensorfold serve when a request needs it, and can stop it when idle",
          kind: "custom",
          run: runLocalSetup,
          runNonInteractive: configureLocalNonInteractive,
          appGuidedSetup: {
            detectAvailability: async (ctx) => Boolean(await detectLocal(ctx)),
            detect: detectLocal,
            prepare: prepareDetected,
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          if (hasConfiguredModels(ctx.config)) return null;
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) return null;
          const baseUrl = resolveBaseUrl(ctx.config, ctx.env);
          try {
            const models = await fetchModels({ baseUrl, apiKey: discoveryApiKey, signal: ctx.signal });
            return models.length > 0 ? { provider: { baseUrl, api: "openai-completions", apiKey, models } } : null;
          } catch (error) {
            api.logger.warn(`TensorFold discovery at ${baseUrl} failed: ${String(error)}`);
            return null;
          }
        },
      },
      buildUnknownModelHint: () =>
        `Start tensorfold serve, then set ${API_KEY_ENV} (any value for a server without keys) or run ` +
        `"openclaw onboard --auth-choice tensorfold-api-key". TENSORFOLD_BASE_URL sets another address than ${DEFAULT_BASE_URL}.`,
    });

    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["text"],
      liveCatalog: async (ctx) => {
        const { discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        const models = await fetchModels({
          baseUrl: resolveBaseUrl(ctx.config, ctx.env),
          apiKey: discoveryApiKey,
          signal: ctx.signal,
        }).catch(() => null);
        return models?.map((m) => ({ kind: "text", provider: PROVIDER_ID, model: m.id, label: m.name, source: "live" }));
      },
    });
  },
});
