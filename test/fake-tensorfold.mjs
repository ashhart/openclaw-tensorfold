#!/usr/bin/env node
// A stand-in for `tensorfold serve`: same flags, /health open, /v1/models behind the key file's key.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("tensorfold-native 9.9.9");
  process.exit(0);
}
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] !== "serve" || process.env.FAKE_TF_FAIL) {
  console.error("error: the model could not be loaded");
  process.exit(1);
}
const key = /:\s*(\S+)\s*$/m.exec(readFileSync(flag("--api-key-file"), "utf8"))[1];
const model = {
  id: flag("--name"),
  capabilities: { text_generation: true, reasoning: true, thinking_switch: true },
  context_length: Number(flag("--context")),
  reasoning: { default_enabled: true, supported_efforts: ["low", "high", "none"] },
};
const server = createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(200).end('{"status":"ok"}');
  if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end("{}");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [model] }));
});
setTimeout(() => server.listen(Number(flag("--port")), flag("--host")), Number(process.env.FAKE_TF_DELAY_MS ?? 300));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
