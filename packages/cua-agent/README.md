# DynFlow Cua + Pi Agent Image

Docker image used by DynFlow's `CuaAgentRunner`. It bundles:

- **Base**: [`trycua/cua-xfce`](https://hub.docker.com/r/trycua/cua-xfce) — Ubuntu 22.04 + XFCE desktop + Cua computer-server (HTTP API on :8000) + noVNC (web VNC on :6901)
- **Added**: [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — the Pi CLI

## Build

```bash
cd packages/cua-agent
npm run build:image
# → tagged as dynflow-cua-pi:latest
```

## How DynFlow uses it

`CuaAgentRunner` (`packages/server/src/runner/cua-runner.ts`) starts a container from this image:

```bash
docker run -d \
  -p <noVncPort>:6901 \
  -p <cuaApiPort>:8000 \
  -v <host-workspace>:/home/cua/workspace \
  -e ANTHROPIC_API_KEY=... \
  -e OPENAI_API_KEY=... \
  -e OPENAI_BASE_URL=... \
  -e PI_CWD=/home/cua/workspace \
  dynflow-cua-pi:latest
```

Then it `docker exec`s the container to run `pi --mode json --no-session` against a prompt file in the workspace. The container stays alive after the agent finishes so the noVNC URL and computer-server API remain available to the user. The `--provider` / `--model` flags passed by `CuaAgentRunner` are forwarded to the in-container `pi` so per-run `RuntimeConfig` overrides (e.g. switching to the `minimax` provider) work without rebuilding the image.

## Environment variables

The image inherits the `trycua/cua-xfce` base, which configures:

| Variable | Default | Notes |
|---|---|---|
| `VNC_RESOLUTION` | `1024x768` | XFCE screen size |
| `VNC_PW` | `password` | VNC password (not used by DynFlow, exposed for manual debugging) |
| `PI_CWD` | `/home/cua/workspace` | Where Pi starts by default (set by the runner) |
| `OPENAI_BASE_URL` | _(unset)_ | Forwarded by the runner when set. Used by the `openai` and `minimax` OpenAI-compatible providers. |
| `OPENAI_API_KEY` | _(unset)_ | Forwarded by the runner when set. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Forwarded by the runner when set. |

## Smoke test

```bash
npm run smoke   # starts the container for 30s
docker exec cua-smoke which pi       # should print a path
docker stop cua-smoke
```

> **Note**: As of 2026-06-01, this image was authored but not built in the
> development environment because Docker was not available locally. The
> Dockerfile, scripts, and config have been validated by code review.
> To verify the image in a Docker-enabled environment, run
> `npm run build:image && npm run smoke`.
