# ---------------------------------------------------------------------------
# THE AGENT IN A CONTAINER — the strongest of the three isolation levels, and
# the one that changes what the agent can do for you.
#
# WHAT IT IS. A container that runs ONLY the gateway. Nothing from this
# machine is mounted into it: no vault.key, no database, no repository, no home
# directory. It reaches the dashboard the way anything else would — over HTTP,
# with the scoped agent key — and that key is refused on the owner surface
# (credentials, backups, the password, the agent processes) by the API itself.
#
# WHAT YOU GIVE UP, said before the build instructions rather than after. The
# agent's terminal tool now runs inside this container. That means no `git` in
# your repositories, no `ffmpeg` on your files, no reading a document you asked
# it about, and no `opc` unless you accept the CLI into the image (below). An
# agent that can only talk to the API is a considerably less useful agent, and
# for most single-owner installs the separate-user level is the better trade.
# Choose deliberately.
#
# THIS FILE IS NOT BUILT OR RUN BY THE APP, AND THE PAGE WILL NEVER SAY YOU ARE
# ON THIS LEVEL. The managed-agent installer in server/src/agents/instance.ts
# spawns a local process; it does not drive Docker, does not look for a
# container, and `isolation.ts` reports only the two levels it can measure
# (`same-user`, `separate-user`). A level nothing can observe is not offered as
# one. This is a documented manual path, and `containerPath` on the isolation
# report says exactly that.
#
# IT ALSO NEEDS THE API REACHABLE FROM THE CONTAINER, WHICH IT IS NOT. The
# server binds 127.0.0.1 on purpose. Read the header of agent-compose.yml
# before building this — that is where the two real options are, and both of
# them cost you something.
# ---------------------------------------------------------------------------

# Pinned rather than `latest`, for the reason the OpenClaw version is pinned in
# instance.ts: "which runtime is running" has to be answerable later.
FROM node:24.18-bookworm-slim

# The gateway runs as a non-root user inside the container as well. Two layers
# of "not root" cost nothing and the outer one can be turned off by a flag.
RUN useradd --create-home --shell /usr/sbin/nologin agent
USER agent
WORKDIR /home/agent

# OPENCLAW, PINNED. Swap this stanza for the Hermes installer if that is the
# gateway you run; the rest of the file is the same either way.
ARG OPENCLAW_VERSION=2026.9.1
RUN npm install --no-fund --no-audit "openclaw@${OPENCLAW_VERSION}"

# The gateway's own door. It is published to the host so the dashboard can
# reach it; bind it to 127.0.0.1 on the host side (see the compose file) so it
# is not on the network.
EXPOSE 18789

ENV OPENCLAW_HOME=/home/agent

# NO VOLUME AND NO MOUNT. That is the whole point of this file, so it is stated
# as an absence rather than left implied. Anything this container needs to
# remember — including the gateway's own config, written to
# $OPENCLAW_HOME/.openclaw/openclaw.json on first run — lives in its own
# writable filesystem and goes when the container does. That is why the compose
# file does NOT set `read_only: true`: a read-only root would stop the gateway
# starting, and the obvious fix would be the host mount this file exists to
# avoid. The things worth keeping — the chat history, the memory, the board —
# are in the dashboard's database, on the other side of the API.

CMD ["npx", "openclaw", "gateway", "run"]
