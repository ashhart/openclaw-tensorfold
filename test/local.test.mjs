import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cachedModels,
  choosePort,
  ensureKeyFile,
  findBinary,
  localProvider,
  probe,
  serveArgs,
  servedName,
} from "../dist/local.js";
import { configureLocalNonInteractive, runLocalSetup } from "../dist/setup.js";

const fake = fileURLToPath(new URL("./fake-tensorfold.mjs", import.meta.url));
chmodSync(fake, 0o755);
const scratch = () => mkdtempSync(join(tmpdir(), "oc-tf-"));

describe("finding TensorFold and models", () => {
  it("takes TENSORFOLD_BINARY when it is an absolute executable", () => {
    assert.equal(findBinary({ TENSORFOLD_BINARY: fake }), fake);
    assert.equal(findBinary({ TENSORFOLD_BINARY: "tensorfold" }), undefined);
  });

  it("finds tensorfold on PATH", () => {
    const dir = scratch();
    writeFileSync(join(dir, "tensorfold"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findBinary({ PATH: `/nowhere:${dir}` }), join(dir, "tensorfold"));
  });

  it("lists cached Hugging Face repos with TensorFold's first", () => {
    const hub = scratch();
    for (const repo of ["models--acme--tiny", "models--TensorFold--Qwen3.8-27B-MLX-4bit", "datasets--x--y"]) {
      mkdirSync(join(hub, repo, "snapshots"), { recursive: true });
    }
    assert.deepEqual(cachedModels({ HF_HUB_CACHE: hub }), ["TensorFold/Qwen3.8-27B-MLX-4bit", "acme/tiny"]);
    assert.deepEqual(cachedModels({ HF_HUB_CACHE: join(hub, "missing") }), []);
  });

  it("names the served model after the repo, not a snapshot hash", () => {
    assert.equal(servedName("TensorFold/Qwen3.8-27B-MLX-4bit"), "Qwen3.8-27B-MLX-4bit");
    assert.equal(servedName("/c/hub/models--TensorFold--Nemotron-3.5/snapshots/d9d758fb"), "Nemotron-3.5");
    assert.equal(servedName("/models/my-model/"), "my-model");
  });
});

describe("the local server", () => {
  it("keeps one 0600 key file and reuses it", () => {
    const state = scratch();
    const first = ensureKeyFile(state);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.equal(ensureKeyFile(state).key, first.key);
  });

  it("binds loopback with the key file and the chosen window", async () => {
    const port = await choosePort();
    assert.ok(port >= 18180);
    const plan = { binary: fake, model: "TensorFold/M", name: "M", port, context: 4096, keyFile: "/k" };
    assert.deepEqual(serveArgs(plan), [
      "serve", "TensorFold/M", "--name", "M", "--host", "127.0.0.1", "--port", String(port),
      "--api-key-file", "/k", "--context", "4096", "--no-update-check",
    ]);
    const provider = localProvider(plan, "key", [], 900000);
    assert.equal(provider.localService.command, fake);
    assert.equal(provider.localService.healthUrl, `http://127.0.0.1:${port}/health`);
    assert.equal(provider.localService.idleStopMs, 900000);
    assert.equal(provider.baseUrl, `http://127.0.0.1:${port}/v1`);
  });

  it("starts the server once, reads its model, and stops it", async () => {
    const { path, key } = ensureKeyFile(scratch());
    const plan = { binary: fake, model: "TensorFold/M", name: "M", port: await choosePort(), context: 8192, keyFile: path };
    const models = await probe(plan, key, 20000);
    assert.equal(models[0].id, "M");
    assert.equal(models[0].contextWindow, 8192);
    assert.deepEqual(models[0].compat.supportedReasoningEfforts, ["low", "high", "none"]);
    const after = await fetch(`http://127.0.0.1:${plan.port}/health`).then(() => "up", () => "down");
    assert.equal(after, "down");
  });

  it("reports the server's own words when it fails to start", async () => {
    process.env.FAKE_TF_FAIL = "1";
    try {
      const { path, key } = ensureKeyFile(scratch());
      const plan = { binary: fake, model: "x", name: "x", port: await choosePort(), context: 8192, keyFile: path };
      await assert.rejects(probe(plan, key, 20000), /exited before it was ready:\nerror: the model could not be loaded/);
    } finally {
      delete process.env.FAKE_TF_FAIL;
    }
  });
});

describe("unattended setup", () => {
  it("writes a provider OpenClaw starts on demand and keeps other providers", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      TENSORFOLD_BINARY: fake,
      TENSORFOLD_MODEL: "TensorFold/Qwen3.8-27B-MLX-4bit",
      TENSORFOLD_CONTEXT: "16384",
      TENSORFOLD_IDLE_STOP_MINUTES: "15",
      OPENCLAW_STATE_DIR: scratch(),
    });
    try {
      const config = { models: { providers: { other: { baseUrl: "http://x/v1", models: [] } } } };
      const runtime = { error: (m) => assert.fail(m), exit: () => assert.fail("exit") };
      const out = await configureLocalNonInteractive({ config, runtime });
      const tf = out.models.providers.tensorfold;
      assert.ok(out.models.providers.other);
      assert.equal(out.agents.defaults.model.primary, "tensorfold/Qwen3.8-27B-MLX-4bit");
      assert.equal(tf.localService.idleStopMs, 900000);
      assert.equal(tf.models[0].contextWindow, 16384);
      assert.ok(tf.localService.args.includes("--api-key-file"));
      assert.equal(statSync(join(process.env.OPENCLAW_STATE_DIR, "tensorfold", "server.keys")).mode & 0o777, 0o600);
    } finally {
      process.env = saved;
    }
  });
});

describe("interactive setup", () => {
  it("asks for the model, window and idle stop, then returns the provider and default model", async () => {
    const hub = scratch();
    mkdirSync(join(hub, "models--TensorFold--Tiny-MLX-4bit", "snapshots"), { recursive: true });
    const asked = [];
    const prompter = {
      note: async () => {},
      select: async ({ message, options }) => (asked.push(message), options[0].value),
      text: async ({ message, initialValue }) => (asked.push(message), initialValue ?? ""),
      progress: () => ({ update() {}, stop() {} }),
    };
    const env = { TENSORFOLD_BINARY: fake, HF_HUB_CACHE: hub, OPENCLAW_STATE_DIR: scratch(), PATH: process.env.PATH };
    const result = await runLocalSetup({ config: {}, env, prompter, runtime: {} });
    assert.deepEqual(asked, ["Model for TensorFold to serve", "Context window in tokens", "When OpenClaw has started it"]);
    assert.equal(result.defaultModel, "tensorfold/Tiny-MLX-4bit");
    const tf = result.configPatch.models.providers.tensorfold;
    assert.equal(tf.models[0].contextWindow, 65536);
    assert.equal(tf.localService.idleStopMs, 0);
  });
});
