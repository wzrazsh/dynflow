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
  -e PI_CWD=/home/cua/workspace \
  dynflow-cua-pi:latest
```

Then it `docker exec`s the container to run `pi --mode json --no-session` against a prompt file in the workspace. The container stays alive after the agent finishes so the noVNC URL and computer-server API remain available to the user.

## Environment variables

The image inherits the `trycua/cua-xfce` base, which configures:

| Variable | Default | Notes |
|---|---|---|
| `VNC_RESOLUTION` | `1024x768` | XFCE screen size |
| `VNC_PW` | `password` | VNC password (not used by DynFlow, exposed for manual debugging) |
| `PI_CWD` | `/home/cua/workspace` | Where Pi starts by default (set by the runner) |

## Smoke test

```bash
npm run smoke   # starts the container for 30s
docker exec cua-smoke which pi       # should print a path
docker stop cua-smoke
```
