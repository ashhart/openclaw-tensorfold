# Changelog

## 0.2.3

- Releases publish from GitHub Actions with npm and ClawHub trusted publishing: one tarball, built and tested from the
  version tag, goes to both registries, and no publish token is stored anywhere.

## 0.2.2

- README with the TensorFold banner, a quick start and what the plugin does; `assets/icon.png` for ClawHub's listing.

## 0.2.1

- Licensed under Apache-2.0, as TensorFold is. 0.1.0 and 0.2.0 were MIT.

## 0.2.0

- `openclaw onboard --auth-choice tensorfold-local`: OpenClaw starts `tensorfold serve` on demand through its local
  model service and stops it on exit or when idle. Setup reads the model's window and reasoning levels by starting it
  once, and keeps the server's key in a 0600 file under OpenClaw's state folder.

## 0.1.0

- A `tensorfold` provider that reads `/v1/models`: each model's context window, image input and reasoning efforts, with
  OpenClaw's thinking levels sent as `reasoning_effort`.
