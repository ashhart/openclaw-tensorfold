import type { OpenClawConfig, ProviderCatalogResult } from "openclaw/plugin-sdk/plugin-entry";

type ProviderConfig = Extract<NonNullable<ProviderCatalogResult>, { provider: unknown }>["provider"];
export type ModelEntry = ProviderConfig["models"][number];

export const PROVIDER_ID = "tensorfold";
export const API_KEY_ENV = "TENSORFOLD_API_KEY";
export const BASE_URL_ENV = "TENSORFOLD_BASE_URL";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

const FALLBACK_CONTEXT = 32768;
const REPLY_CAP = 8192;
const FETCH_TIMEOUT_MS = 5000;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A base URL without a path gets TensorFold's /v1 prefix; trailing slashes go. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  return url.pathname === "/" || url.pathname === "" ? `${trimmed}/v1` : trimmed;
}

/** The configured provider's baseUrl wins, then TENSORFOLD_BASE_URL, then tensorfold serve's loopback default. */
export function resolveBaseUrl(config: OpenClawConfig | undefined, env: NodeJS.ProcessEnv): string {
  const configured = fields(fields(config?.models?.providers)?.[PROVIDER_ID])?.baseUrl;
  const chosen = [configured, env[BASE_URL_ENV]].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return normalizeBaseUrl(chosen ?? DEFAULT_BASE_URL);
}

/** True when the user listed TensorFold models by hand; their list then stands and discovery stays out. */
export function hasConfiguredModels(config: OpenClawConfig | undefined): boolean {
  const models = fields(fields(config?.models?.providers)?.[PROVIDER_ID])?.models;
  return Array.isArray(models) && models.length > 0;
}

/** Effort levels to send as reasoning_effort: the template's own, or only "none" for a bare thinking switch. */
function reasoningEfforts(reasoning: Fields | undefined, capabilities: Fields): string[] {
  const named = Array.isArray(reasoning?.supported_efforts)
    ? reasoning.supported_efforts.filter((e): e is string => typeof e === "string" && e.trim() !== "")
    : [];
  if (named.length > 0) return named;
  return capabilities.thinking_switch === true ? ["none"] : [];
}

/** One /v1/models entry as an OpenClaw model, from what the server reports rather than from its name. */
export function modelFromEntry(entry: unknown): ModelEntry | undefined {
  const served = fields(entry);
  const id = typeof served?.id === "string" ? served.id.trim() : "";
  if (!served || !id) return undefined;
  const capabilities = fields(served.capabilities) ?? {};
  if (capabilities.text_generation === false) return undefined;
  const reasoning = fields(served.reasoning);
  const thinks = reasoning !== undefined || capabilities.reasoning === true;
  const contextWindow = positive(served.context_length) ?? positive(served.max_model_len) ?? FALLBACK_CONTEXT;
  return {
    id,
    name: `${id} (TensorFold)`,
    reasoning: thinks,
    input: capabilities.vision === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(REPLY_CAP, Math.floor(contextWindow / 2)),
    compat: {
      supportsUsageInStreaming: true,
      ...(thinks ? { supportedReasoningEfforts: reasoningEfforts(reasoning, capabilities) } : {}),
    },
  };
}

/** Reads the served models; throws on a refused, unreachable or malformed server. */
export async function fetchModels(params: {
  baseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<ModelEntry[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const headers: Record<string, string> = { accept: "application/json" };
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  const response = await fetch(`${params.baseUrl}/models`, { headers, signal });
  if (!response.ok) throw new Error(`TensorFold /v1/models answered HTTP ${response.status}`);
  const data = fields(await response.json())?.data;
  if (!Array.isArray(data)) throw new Error("TensorFold /v1/models sent no data list");
  return data.flatMap((entry) => modelFromEntry(entry) ?? []);
}
