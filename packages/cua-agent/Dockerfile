# packages/cua-agent/Dockerfile
#
# Cua sandbox + Pi coding agent image. See README.md for usage.

FROM trycua/cua-xfce:latest

USER root

# Install Pi (coding agent) globally.
# Pinned to a major version range so the base + pi stay in sync.
RUN npm install -g @earendil-works/pi-coding-agent@^0.78.0

# Make Pi's working directory match the workspace mount.
ENV PI_CWD=/home/cua/workspace
ENV HOME=/home/cua

# trycua/cua-xfce already provides an ENTRYPOINT that brings up
# the desktop, computer-server (port 8000), and noVNC (port 6901).
# We do not start Pi here — the DynFlow CuaAgentRunner triggers Pi
# on demand via `docker exec`.

LABEL org.dynflow.component="cua-agent"
LABEL org.dynflow.version="0.1.0"
