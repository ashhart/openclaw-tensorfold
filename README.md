# openclaw-tensorfold

An [OpenClaw](https://github.com/openclaw/openclaw) provider plugin for [TensorFold](https://github.com/ashhart/TensorFold)'s
native server (`tensorfold serve`).

The plugin adds a `tensorfold` provider. Instead of a hand-written model list, it reads the server's `/v1/models`, so
OpenClaw gets each served model's real context window, whether it takes images, and the reasoning effort levels its
chat template understands. OpenClaw's thinking levels then go to the server as `reasoning_effort`, and "off" becomes
`none` when the template can switch thinking off.

It registers one model provider and nothing else: no tools, hooks, commands or background services. It connects only
to the TensorFold server you point it at.

## Requirements

- OpenClaw 2026.11.3 or later
- TensorFold 1.0 or later (checked with 1.2.8)
- Node 24.16 or later, as OpenClaw itself needs

## Start TensorFold

Serve a model on loopback with an API key file. A key scoped to `inference,read` is enough:

```sh
tensorfold serve /path/to/model --name my-model --host 127.0.0.1 --port 8080 --api-key-file server.keys
```

See TensorFold's [API key docs](https://github.com/ashhart/TensorFold/blob/main/docs/api.md#api-keys) for the key file
format. A server started without keys works too. OpenClaw still wants a key to register the provider, so give it any
value.

## Install and connect

```sh
openclaw plugins install npm:openclaw-tensorfold
export TENSORFOLD_API_KEY=<a key from server.keys>
openclaw onboard --auth-choice tensorfold-api-key
```

The package is on npm. It is also published to ClawHub, where `openclaw plugins install openclaw-tensorfold` works
once ClawHub's review of the release finishes.

Onboarding saves the key and sets the first served model as your default. To skip onboarding, keep
`TENSORFOLD_API_KEY` in the environment. The plugin uses `http://127.0.0.1:8080/v1` (`tensorfold serve`'s default) unless
you set `TENSORFOLD_BASE_URL` or `models.providers.tensorfold.baseUrl` in OpenClaw's config. A bare address such as
`http://gpu-box:8080` gets `/v1` added.

```sh
openclaw models list --provider tensorfold --refresh
openclaw agent --local --model tensorfold/my-model -m "Hello"
```

If you list TensorFold models by hand under `models.providers.tensorfold.models`, the plugin leaves your list alone
and skips discovery.

## Thinking levels

| What `/v1/models` reports | What OpenClaw sends |
| --- | --- |
| `reasoning.supported_efforts`, for example Qwen3.8's `low`, `medium`, `xhigh`, `none` | Your level as `reasoning_effort`, rounded down to one the template names; off sends `none` |
| A thinking switch with no levels, for example Nemotron 3.5 | Off sends `none`. Any other level sends nothing, so the template's default (thinking on) applies |
| Reasoning that can't be switched off | Nothing; the template decides |
| No reasoning | Nothing |

## Checked

On an Apple M5 Max (Metal) with TensorFold 1.2.8 and OpenClaw 2026.11.3, with the plugin installed from its packed
tarball (`openclaw plugins install npm-pack:...`):

| Check | Result |
| --- | --- |
| `openclaw plugins inspect tensorfold --runtime` | loaded, provider `tensorfold` |
| `models list --refresh`, Nemotron 3.5 Lightning 30B-A3B | listed with its 65,536-token window |
| Agent turn with tools: write `primes.py`, run it, report the output | written, run, correct output, 14 s |
| `--thinking off` and `high` on Nemotron | thinking off, then the template's default |
| `--thinking low`, `medium`, `xhigh`, `off` on Qwen3.8-27B | the server heard `low`, `medium`, `xhigh`, then thinking off |
| `onboard --auth-choice tensorfold-api-key`, then a turn without the environment key | key saved, default model `tensorfold/Qwen3.8-27B`, answered |

## Development

```sh
npm install
npm test
```

`npm test` builds `dist/` and runs the tests against a local fake server. To try a build in OpenClaw:

```sh
npm pack
openclaw plugins install npm-pack:./openclaw-tensorfold-0.1.0.tgz --force
openclaw plugins inspect tensorfold --runtime --json
```

## License

MIT
