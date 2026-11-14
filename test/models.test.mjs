import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import entry from "../dist/index.js";
import {
  DEFAULT_BASE_URL,
  fetchModels,
  hasConfiguredModels,
  modelFromEntry,
  normalizeBaseUrl,
  resolveBaseUrl,
} from "../dist/models.js";

const qwen = {
  id: "Qwen3.8-27B",
  object: "model",
  owned_by: "tensorfold",
  capabilities: { text_generation: true, reasoning: true, thinking_switch: true, vision: false },
  context_length: 131072,
  max_model_len: 131072,
  reasoning: { default_enabled: true, default_effort: "xhigh", supported_efforts: ["low", "medium", "xhigh", "none"] },
};
const plain = { id: "plain-4b", capabilities: { text_generation: true, reasoning: false }, context_length: 8192 };

describe("modelFromEntry", () => {
  it("takes the window and effort levels from the server", () => {
    const model = modelFromEntry(qwen);
    assert.equal(model.id, "Qwen3.8-27B");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 131072);
    assert.equal(model.maxTokens, 8192);
    assert.deepEqual(model.input, ["text"]);
    assert.deepEqual(model.compat.supportedReasoningEfforts, ["low", "medium", "xhigh", "none"]);
    assert.equal(model.compat.supportsUsageInStreaming, true);
  });

  it("sends no effort for a model without reasoning", () => {
    const model = modelFromEntry(plain);
    assert.equal(model.reasoning, false);
    assert.equal(model.compat.supportedReasoningEfforts, undefined);
    assert.equal(model.maxTokens, 4096);
  });

  it("offers only none for a bare thinking switch, and nothing without one", () => {
    const bare = { id: "m", capabilities: { reasoning: true, thinking_switch: true }, reasoning: { default_enabled: true } };
    assert.deepEqual(modelFromEntry(bare).compat.supportedReasoningEfforts, ["none"]);
    const fixed = { id: "m", capabilities: { reasoning: true, thinking_switch: false }, reasoning: { default_enabled: true } };
    assert.deepEqual(modelFromEntry(fixed).compat.supportedReasoningEfforts, []);
  });

  it("adds image input only when the server reports vision", () => {
    assert.deepEqual(modelFromEntry({ id: "v", capabilities: { vision: true } }).input, ["text", "image"]);
  });

  it("falls back to a 32K window and skips non-chat entries", () => {
    assert.equal(modelFromEntry({ id: "x" }).contextWindow, 32768);
    assert.equal(modelFromEntry({ id: "embed", capabilities: { text_generation: false } }), undefined);
    assert.equal(modelFromEntry({ id: " " }), undefined);
    assert.equal(modelFromEntry(null), undefined);
  });
});

describe("base URL", () => {
  it("adds /v1 to a bare origin and drops trailing slashes", () => {
    assert.equal(normalizeBaseUrl("http://box:8080"), "http://box:8080/v1");
    assert.equal(normalizeBaseUrl("http://box:8080/v1/"), "http://box:8080/v1");
  });

  it("prefers the configured provider, then the environment, then the default", () => {
    const config = { models: { providers: { tensorfold: { baseUrl: "http://a:1/v1" } } } };
    const env = { TENSORFOLD_BASE_URL: "http://b:2" };
    assert.equal(resolveBaseUrl(config, env), "http://a:1/v1");
    assert.equal(resolveBaseUrl({}, env), "http://b:2/v1");
    assert.equal(resolveBaseUrl({}, {}), DEFAULT_BASE_URL);
  });

  it("treats a hand-written model list as the user's choice", () => {
    assert.equal(hasConfiguredModels({ models: { providers: { tensorfold: { models: [{ id: "a" }] } } } }), true);
    assert.equal(hasConfiguredModels({ models: { providers: { tensorfold: { baseUrl: "http://a/v1" } } } }), false);
  });
});

describe("against a server", () => {
  let server;
  let baseUrl;
  const seen = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      if (req.headers.authorization !== "Bearer good") {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"unauthorized"}}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [qwen, plain] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("reads /v1/models with the bearer key", async () => {
    const models = await fetchModels({ baseUrl, apiKey: "good" });
    assert.deepEqual(models.map((m) => m.id), ["Qwen3.8-27B", "plain-4b"]);
    assert.equal(seen.at(-1).url, "/v1/models");
  });

  it("throws on a refused key", async () => {
    await assert.rejects(fetchModels({ baseUrl, apiKey: "bad" }), /HTTP 401/);
  });

  it("registers a provider whose catalog lists the served models", async () => {
    const providers = [];
    const catalogs = [];
    const warnings = [];
    entry.register({
      registerProvider: (p) => providers.push(p),
      registerModelCatalogProvider: (c) => catalogs.push(c),
      logger: { warn: (m) => warnings.push(m), info() {}, error() {}, debug() {} },
    });
    assert.equal(providers.length, 1);
    const provider = providers[0];
    assert.equal(provider.id, "tensorfold");
    assert.deepEqual(provider.envVars, ["TENSORFOLD_API_KEY"]);
    const ctx = (key) => ({
      config: { models: { providers: { tensorfold: { baseUrl } } } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: key, discoveryApiKey: key }),
    });
    const result = await provider.catalog.run(ctx("good"));
    assert.equal(result.provider.baseUrl, baseUrl);
    assert.equal(result.provider.api, "openai-completions");
    assert.equal(result.provider.apiKey, "good");
    assert.deepEqual(result.provider.models.map((m) => m.id), ["Qwen3.8-27B", "plain-4b"]);
    assert.equal(await provider.catalog.run(ctx(undefined)), null);
    assert.equal(await provider.catalog.run(ctx("bad")), null);
    assert.match(warnings.at(-1), /HTTP 401/);
    const rows = await catalogs[0].liveCatalog(ctx("good"));
    assert.deepEqual(rows.map((r) => r.model), ["Qwen3.8-27B", "plain-4b"]);
  });
});
