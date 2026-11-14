<p align="center">
  <img src="https://raw.githubusercontent.com/ashhart/openclaw-tensorfold/main/assets/banner.png" alt="TensorFold" width="100%">
</p>

<h1 align="center">TensorFold for OpenClaw</h1>

<p align="center">
  Run OpenClaw's agent on your own Mac or NVIDIA GPU. OpenClaw starts TensorFold when a request needs it.
</p>

<p align="center">
  <a href="https://clawhub.ai/ashhart/plugins/openclaw-tensorfold"><img src="https://img.shields.io/badge/ClawHub-openclaw--tensorfold-e8492f" alt="ClawHub"></a>
  <a href="https://www.npmjs.com/package/openclaw-tensorfold"><img src="https://img.shields.io/npm/v/openclaw-tensorfold?color=6b4dff" alt="npm"></a>
  <a href="https://github.com/ashhart/openclaw-tensorfold/actions/workflows/ci.yml"><img src="https://github.com/ashhart/openclaw-tensorfold/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2d6cdf" alt="Apache-2.0"></a>
</p>

[TensorFold](https://github.com/ashhart/TensorFold) serves language models from a single Zig binary on Apple Silicon
and NVIDIA GPUs, with no Python or MLX to install. This plugin makes it an OpenClaw model provider.

## Quick start

```sh
brew install ashhart/tensorfold/tensorfold
openclaw plugins install clawhub:openclaw-tensorfold
openclaw onboard --auth-choice tensorfold-local
```

Setup asks for a model, a context window and whether to stop TensorFold when idle. After that, the next agent turn
starts TensorFold on its own.

## What you get

- **TensorFold starts on demand.** OpenClaw launches `tensorfold serve` on the first request that needs it, and stops
  it when OpenClaw exits or after an idle time you choose.
- **The model's real limits.** The provider reads `/v1/models`, so OpenClaw knows each model's context window,
  whether it takes images, and the reasoning levels its chat template names, instead of guessing from the name.
- **Thinking levels that land.** OpenClaw's thinking levels reach the server as `reasoning_effort`, and off becomes
  `none` only when the template can switch thinking off.
- **Private by default.** The server listens on `127.0.0.1` behind a key kept in a file only you can read.
- **Your own server works too.** Point the provider at a `tensorfold serve` you run yourself, on this computer or
  another.

## Requirements

- OpenClaw 2026.11.3 or later
- TensorFold 1.0 or later (checked with 1.2.8): `brew install ashhart/tensorfold/tensorfold`
- Node 24.16 or later, as OpenClaw itself needs

## Let OpenClaw start TensorFold

```sh
openclaw plugins install clawhub:openclaw-tensorfold
openclaw onboard --auth-choice tensorfold-local
```

Setup asks three things: the model (models you have already downloaded are listed first, or give a folder or a
Hugging Face id), the context window (65,536 tokens unless you say otherwise), and whether to stop TensorFold when it
sits idle. It then starts TensorFold once to read the model's real window and reasoning levels, stops it, and writes
OpenClaw's [local model service](https://docs.openclaw.ai/gateway/local-model-services) entry under
`models.providers.tensorfold`.

From then on, the first request that needs the model starts `tensorfold serve` on `127.0.0.1` (a free port from 18180
up), waits for its `/health`, and sends the request. OpenClaw stops the server when it exits, or after the idle time
you chose. The server and OpenClaw share one key, kept in `tensorfold/server.keys` (mode 0600) under OpenClaw's state
folder, so a program needs that key to use the server, and other users on the computer can't read it.

The plugin looks for `tensorfold` on `PATH` and in Homebrew's folders. Set `TENSORFOLD_BINARY` to an absolute path to
use another build. For unattended setup:

```sh
TENSORFOLD_MODEL=TensorFold/Qwen3.8-27B-MLX-4bit TENSORFOLD_CONTEXT=65536 TENSORFOLD_IDLE_STOP_MINUTES=15 \
  openclaw onboard --non-interactive --accept-risk --mode local --skip-health --auth-choice tensorfold-local
```

## Or connect to a server you run

```sh
tensorfold serve /path/to/model --name my-model --host 127.0.0.1 --port 8080 --api-key-file server.keys
openclaw plugins install clawhub:openclaw-tensorfold
export TENSORFOLD_API_KEY=<a key from server.keys>
openclaw onboard --auth-choice tensorfold-api-key
```

See TensorFold's [API key docs](https://github.com/ashhart/TensorFold/blob/main/docs/api.md#api-keys) for the key file
format; a key scoped to `inference,read` is enough. A server started without keys works too, but OpenClaw still wants
a key to register the provider, so give it any value.

Onboarding saves the key and sets the first served model as your default. The plugin uses `http://127.0.0.1:8080/v1`
(`tensorfold serve`'s default) unless you set `TENSORFOLD_BASE_URL` or `models.providers.tensorfold.baseUrl`. A bare
address such as `http://gpu-box:8080` gets `/v1` added. If you list TensorFold models by hand under
`models.providers.tensorfold.models`, the plugin leaves your list alone and skips discovery.

The `clawhub:` install takes ClawHub's scanned copy of the release. The same package is on npm as
`npm:openclaw-tensorfold`; OpenClaw asks you to confirm an install from outside ClawHub (`--force` without a prompt).

## Thinking levels

| What `/v1/models` reports | What OpenClaw sends |
| --- | --- |
| `reasoning.supported_efforts`, for example Qwen3.8's `low`, `medium`, `xhigh`, `none` | Your level as `reasoning_effort`, rounded down to one the template names; off sends `none` |
| A thinking switch with no levels, for example Nemotron 3.5 | Off sends `none`. Any other level sends nothing, so the template's default (thinking on) applies |
| Reasoning that can't be switched off | Nothing; the template decides |
| No reasoning | Nothing |

## Checked

On an Apple M5 Max (Metal) with TensorFold 1.2.8 and OpenClaw 2026.11.3:

| Check | Result |
| --- | --- |
| `onboard --auth-choice tensorfold-local`, unattended, Nemotron 3.5 Lightning 30B-A3B | 17 s: started and stopped TensorFold once, wrote the service with the 65,536-token window |
| Agent turn with no server running: write `fib.py`, run it, report the output | OpenClaw started TensorFold (ready in 3.0 s), the right output, server stopped when OpenClaw exited; 20 s |
| Install from ClawHub, and from npm, into an empty OpenClaw | loaded, provider `tensorfold` |
| Connecting to a running server: agent turn with tools (`primes.py`) | written, run, correct output, 14 s |
| `--thinking off` and `high` on Nemotron | thinking off, then the template's default |
| `--thinking low`, `medium`, `xhigh`, `off` on Qwen3.8-27B | the server heard `low`, `medium`, `xhigh`, then thinking off |
| `onboard --auth-choice tensorfold-api-key`, then a turn without the environment key | key saved, default model chosen, answered |

Not checked yet: the idle stop inside a long-running Gateway, and a CUDA host.

## Development

```sh
npm install
npm test
```

`npm test` builds `dist/` and runs the tests against a fake server and a fake `tensorfold` binary. To try a build in
OpenClaw:

```sh
npm pack
openclaw plugins install npm-pack:./openclaw-tensorfold-0.2.2.tgz --force
openclaw plugins inspect tensorfold --runtime --json
```

## License

Apache-2.0, the same license as TensorFold (see `LICENSE` and `NOTICE`). Releases 0.1.0 and 0.2.0 were MIT.
