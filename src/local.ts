import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fetchModels, type ModelEntry } from "./models.js";

export const DEFAULT_CONTEXT = 65536;
export const READY_TIMEOUT_MS = 600_000;
const FIRST_PORT = 18180;
const BINARY_NAMES = ["tensorfold", "tensorfold-native"];
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** TENSORFOLD_BINARY first, then PATH, then Homebrew's folders; localService needs an absolute path. */
export function findBinary(env: NodeJS.ProcessEnv): string | undefined {
  const pinned = env.TENSORFOLD_BINARY?.trim();
  if (pinned) return pinned.startsWith("/") && executable(pinned) ? pinned : undefined;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter((d) => d.startsWith("/")), ...FALLBACK_DIRS];
  for (const name of BINARY_NAMES) for (const dir of dirs) if (executable(join(dir, name))) return join(dir, name);
  return undefined;
}

/** The binary's own version line, such as "tensorfold-native 1.2.8". */
export function binaryVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim().split("\n")[0]);
    });
  });
}

function hubDir(env: NodeJS.ProcessEnv): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  return join(env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
}

/** Hugging Face repos already downloaded, TensorFold's own first; only a hint for the picker. */
export function cachedModels(env: NodeJS.ProcessEnv): string[] {
  let names: string[];
  try {
    names = readdirSync(hubDir(env));
  } catch {
    return [];
  }
  const repos = names
    .filter((n) => n.startsWith("models--") && existsSync(join(hubDir(env), n, "snapshots")))
    .map((n) => n.slice("models--".length).replace("--", "/"));
  return [...repos.filter((r) => r.startsWith("TensorFold/")), ...repos.filter((r) => !r.startsWith("TensorFold/"))];
}

/** The served name: a repo's own name, a cache snapshot's repo, or a folder's name. */
export function servedName(model: string): string {
  const cached = /models--[^/]+--([^/]+)/.exec(model);
  if (cached?.[1]) return cached[1];
  const trimmed = model.replace(/\/+$/, "");
  return basename(trimmed) || trimmed;
}

/** One key for the server and OpenClaw, kept in a 0600 file under OpenClaw's state folder. */
export function ensureKeyFile(stateDir: string): { path: string; key: string } {
  const dir = join(stateDir, "tensorfold");
  const path = join(dir, "server.keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const found = /:\s*(\S+)\s*$/m.exec(readFileSync(path, "utf8"));
    if (found?.[1]) return { path, key: found[1] };
  }
  const key = randomBytes(24).toString("hex");
  writeFileSync(path, `openclaw[inference,read]: ${key}\n`, { mode: 0o600 });
  return { path, key };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A free loopback port from 18180 up, away from tensorfold serve's own 8080. */
export async function choosePort(): Promise<number> {
  for (let port = FIRST_PORT; port < FIRST_PORT + 100; port++) if (await portFree(port)) return port;
  throw new Error("no free loopback port from 18180 to 18279");
}

export type LocalPlan = { binary: string; model: string; name: string; port: number; context: number; keyFile: string };

export function serveArgs(plan: LocalPlan): string[] {
  return [
    "serve", plan.model, "--name", plan.name, "--host", "127.0.0.1", "--port", String(plan.port),
    "--api-key-file", plan.keyFile, "--context", String(plan.context), "--no-update-check",
  ];
}

export const baseUrlOf = (port: number): string => `http://127.0.0.1:${port}/v1`;

/** Starts the server once, reads what it serves, then stops it; the tail of its log explains a failure. */
export async function probe(plan: LocalPlan, key: string, timeoutMs = READY_TIMEOUT_MS): Promise<ModelEntry[]> {
  const child = spawn(plan.binary, serveArgs(plan), { stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const keep = (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-2000));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));
  try {
    const deadline = Date.now() + timeoutMs;
    while (!exited) {
      if (Date.now() > deadline) throw new Error(`TensorFold did not answer /health within ${timeoutMs / 1000} s`);
      const ok = await fetch(`http://127.0.0.1:${plan.port}/health`).then((r) => r.ok, () => false);
      if (ok) return await fetchModels({ baseUrl: baseUrlOf(plan.port), apiKey: key });
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`tensorfold serve exited before it was ready:\n${tail.trim()}`);
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 25_000);
      await exit;
      clearTimeout(forced);
    }
  }
}

/** The provider entry OpenClaw needs to start TensorFold on demand and stop it when idle. */
export function localProvider(plan: LocalPlan, key: string, models: ModelEntry[], idleStopMs: number) {
  return {
    baseUrl: baseUrlOf(plan.port),
    apiKey: key,
    api: "openai-completions" as const,
    timeoutSeconds: 600,
    localService: {
      command: plan.binary,
      args: serveArgs(plan),
      healthUrl: `http://127.0.0.1:${plan.port}/health`,
      readyTimeoutMs: READY_TIMEOUT_MS,
      idleStopMs,
    },
    models,
  };
}
