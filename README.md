# openclaw-tensorfold

An [OpenClaw](https://github.com/openclaw/openclaw) provider plugin for [TensorFold](https://github.com/ashhart/TensorFold).
OpenClaw starts `tensorfold serve` on your computer when a request needs it, or connects to a TensorFold server you
run yourself.

The plugin adds a `tensorfold` provider. Instead of a hand-written model list, it reads the server's `/v1/models`, so
OpenClaw gets each served model's real context window, whether it takes images, and the reasoning effort levels its
chat template understands. OpenClaw's thinking levels then go to the server as `reasoning_effort`, and "off" becomes
`none` when the template can switch thinking off.

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
openclaw plugins install npm-pack:./openclaw-tensorfold-0.2.1.tgz --force
openclaw plugins inspect tensorfold --runtime --json
```

## License

Apache-2.0, the same license as TensorFold (see `LICENSE` and `NOTICE`). Releases 0.1.0 and 0.2.0 were MIT.
