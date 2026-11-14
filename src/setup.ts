import type {
  OpenClawConfig,
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  DEFAULT_CONTEXT,
  binaryVersion,
  cachedModels,
  choosePort,
  ensureKeyFile,
  findBinary,
  localProvider,
  probe,
  servedName,
  type LocalPlan,
} from "./local.js";
import { PROVIDER_ID } from "./models.js";

const INSTALL_HINT = "Install TensorFold with `brew install ashhart/tensorfold/tensorfold`, or set TENSORFOLD_BINARY.";
const IDLE_CHOICES = [
  { value: 0, label: "Keep it running while OpenClaw runs" },
  { value: 15 * 60_000, label: "Stop it after 15 idle minutes" },
  { value: 60 * 60_000, label: "Stop it after an idle hour" },
];

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim() || fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`expected a positive whole number, got "${raw}"`);
  return n;
}

async function plan(env: NodeJS.ProcessEnv, binary: string, model: string, context: number): Promise<LocalPlan> {
  const { path } = ensureKeyFile(resolveStateDir(env));
  return { binary, model, name: servedName(model), port: await choosePort(), context, keyFile: path };
}

/** Starts the model once to read its real window and efforts, then writes a provider OpenClaw starts on demand. */
async function prepare(env: NodeJS.ProcessEnv, chosen: LocalPlan, idleStopMs: number, config: OpenClawConfig) {
  const { key } = ensureKeyFile(resolveStateDir(env));
  const models = await probe(chosen, key);
  if (models.length === 0) throw new Error(`TensorFold served no chat model for ${chosen.model}`);
  const provider = localProvider(chosen, key, models, idleStopMs);
  const patch: Partial<OpenClawConfig> = {
    models: { mode: config.models?.mode ?? "merge", providers: { [PROVIDER_ID]: provider } },
  };
  return { patch, provider, defaultModel: `${PROVIDER_ID}/${models[0]!.id}`, models };
}

export async function runLocalSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const env = ctx.env ?? process.env;
  let binary = findBinary(env);
  if (!binary) {
    await ctx.prompter.note(INSTALL_HINT, "TensorFold not found");
    binary = (await ctx.prompter.text({ message: "Absolute path to the tensorfold binary" })).trim();
    if (!binary.startsWith("/") || !(await binaryVersion(binary))) throw new Error(`${binary} is not a runnable TensorFold binary`);
  }
  const cached = cachedModels(env);
  const other = "\u0000other";
  let model = cached.length
    ? await ctx.prompter.select({
        message: "Model for TensorFold to serve",
        options: [...cached.map((r) => ({ value: r, label: r })), { value: other, label: "Another model (path or Hugging Face id)" }],
        searchable: true,
      })
    : other;
  if (model === other) model = (await ctx.prompter.text({ message: "Model folder or Hugging Face id" })).trim();
  const context = positiveInt(await ctx.prompter.text({ message: "Context window in tokens", initialValue: String(DEFAULT_CONTEXT) }), DEFAULT_CONTEXT);
  const idleStopMs = await ctx.prompter.select({ message: "When OpenClaw has started it", options: IDLE_CHOICES, initialValue: 0 });
  const chosen = await plan(env, binary, model, context);
  const progress = ctx.prompter.progress(`Starting TensorFold once to check ${model}`);
  try {
    const done = await prepare(env, chosen, idleStopMs, ctx.config);
    const first = done.models[0]!;
    progress.stop(`${first.id}: ${(first.contextWindow ?? 0).toLocaleString("en")}-token window`);
    return {
      profiles: [],
      configPatch: done.patch,
      defaultModel: done.defaultModel,
      notes: [`OpenClaw starts TensorFold on 127.0.0.1:${chosen.port} when a request needs it. Key file: ${chosen.keyFile}`],
    };
  } catch (error) {
    progress.stop("TensorFold could not start");
    throw error;
  }
}

/** Unattended setup reads TENSORFOLD_MODEL, and optionally TENSORFOLD_CONTEXT, TENSORFOLD_IDLE_STOP_MINUTES and TENSORFOLD_BINARY. */
export async function configureLocalNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext): Promise<OpenClawConfig | null> {
  const env = process.env;
  const binary = findBinary(env);
  const model = env.TENSORFOLD_MODEL?.trim();
  if (!binary || !model) {
    ctx.runtime.error(binary ? "Set TENSORFOLD_MODEL to a model folder or Hugging Face id." : INSTALL_HINT);
    ctx.runtime.exit(1);
    return null;
  }
  const chosen = await plan(env, binary, model, positiveInt(env.TENSORFOLD_CONTEXT, DEFAULT_CONTEXT));
  const idleMinutes = env.TENSORFOLD_IDLE_STOP_MINUTES ? positiveInt(env.TENSORFOLD_IDLE_STOP_MINUTES, 1) : 0;
  const done = await prepare(env, chosen, idleMinutes * 60_000, ctx.config);
  const models = ctx.config.models;
  return {
    ...ctx.config,
    models: { ...models, mode: models?.mode ?? "merge", providers: { ...models?.providers, [PROVIDER_ID]: done.provider } },
    agents: { ...ctx.config.agents, defaults: { ...ctx.config.agents?.defaults, model: { primary: done.defaultModel } } },
  };
}

/** Offered only when TensorFold is installed and a TensorFold model is already downloaded. */
export async function detectLocal(ctx: ProviderAppGuidedSetupContext) {
  const binary = findBinary(ctx.env);
  const repo = cachedModels(ctx.env).find((r) => r.startsWith("TensorFold/"));
  if (!binary || !repo) return null;
  return { modelRef: `${PROVIDER_ID}/${servedName(repo)}`, detail: `${repo} with ${(await binaryVersion(binary)) ?? "TensorFold"}` };
}

export async function prepareDetected(ctx: ProviderAppGuidedSetupContext & { modelRef: string }): Promise<ProviderAuthResult | null> {
  const binary = findBinary(ctx.env);
  const repo = cachedModels(ctx.env).find((r) => `${PROVIDER_ID}/${servedName(r)}` === ctx.modelRef);
  if (!binary || !repo) return null;
  const done = await prepare(ctx.env, await plan(ctx.env, binary, repo, DEFAULT_CONTEXT), 0, ctx.config);
  return { profiles: [], configPatch: done.patch, defaultModel: done.defaultModel };
}
