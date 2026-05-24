# syntax=docker/dockerfile:1.7
#
# Bombardment Phase 3a — containerize the stavR daemon.
#
# One image is built once and serves both Track 1 (the docker-compose
# federation rig — bombardment/compose/) and Track 2 (the real
# federated gateway on the two Synologys, future Phase 7). Hardening
# the rig hardens the thing the family actually runs.
#
# Multi-stage:
#   builder — installs full dev deps, generates src/version.generated.ts,
#             compiles TypeScript to dist/, prunes to production deps.
#             better-sqlite3 native compile happens here (build tooling
#             confined to this stage per the BOM).
#   runtime — slim node image; copies dist/ + production node_modules
#             from the builder; runs as non-root; HEALTHCHECK on /healthz.
#
# Operator config via env at run time:
#   STAVR_HOME         daemon state dir (mounted volume, defaults /home/stavr/.stavr)
#   STAVR_PEER_ID      self peer id; default 'stavr-self'
#   STAVR_PORT         HTTP/SSE listen port; default 7777
#   STAVR_BIND_HOST    bind host; default 0.0.0.0 (container internal — every
#                      container is its own netns, so binding non-loopback is
#                      the right default here, with the auth gate explicitly
#                      opened via STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH=1).
#   STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH
#                      when '1', adds --allow-non-local-without-auth so the
#                      auth gate doesn't refuse to start in the rig. The
#                      real-deployment image would leave this unset and pair
#                      a device first.
#
# Operator-visible commands:
#   docker build -t stavr:dev .
#   docker run --rm -p 7777:7777 \
#     -e STAVR_ALLOW_NON_LOCAL_WITHOUT_AUTH=1 \
#     -v stavr-home:/home/stavr/.stavr \
#     stavr:dev
#   curl http://localhost:7777/healthz   # 200 = ok
#   curl http://localhost:7777/status    # version == package.json#version

# ---------- stage 1: builder ----------
# Pinned to node 25.7 to match package.json#engines.node (>=25.7).
# Bookworm gives a recent enough glibc + python3 for better-sqlite3.
FROM node:25-bookworm-slim AS builder

# better-sqlite3 builds a native addon — needs python + make + g++.
# Kept in the builder stage only; not present in the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests first so `npm ci` is cached when source-only changes.
COPY package.json package-lock.json ./

# `npm ci` honours the lockfile exactly. `--include=optional` ensures
# wincred et al. are evaluated even though they're optional — failures
# there are tolerated by npm (matches the production install posture).
RUN npm ci --include=optional

# Now the source — version.generated.ts is written by prebuild + tsc emits dist/.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# Strip dev deps. `npm prune --omit=dev` rewrites node_modules in place;
# the resulting tree is what we copy into the runtime stage.
RUN npm prune --omit=dev

# ---------- stage 2: runtime ----------
FROM node:25-bookworm-slim AS runtime

# curl is the cheapest healthcheck — Node images don't ship it.
# tini gives us PID-1 signal forwarding so docker stop terminates cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. node:bookworm-slim already ships a `node` user
# (uid 1000); we create our own `stavr` user so chown / volume semantics
# are explicit and the daemon's process name is unambiguous in `ps`.
RUN groupadd --system --gid 1101 stavr \
    && useradd --system --uid 1101 --gid stavr --create-home --shell /usr/sbin/nologin stavr

# /home/stavr/.stavr is the named-volume mount point (STAVR_HOME).
# Pre-create + chown so a fresh volume mount preserves ownership.
RUN mkdir -p /home/stavr/.stavr \
    && chown -R stavr:stavr /home/stavr

WORKDIR /app

# Pull the compiled output + pruned production deps + the package.json
# (only the version + bin entry are read at runtime; everything else is
# safe to ship). No source, no dev deps, no build tools.
COPY --from=builder --chown=stavr:stavr /build/dist ./dist
COPY --from=builder --chown=stavr:stavr /build/node_modules ./node_modules
COPY --from=builder --chown=stavr:stavr /build/package.json ./package.json

# Entrypoint translates env vars into the right CLI flags, then exec's
# the daemon as the stavr user. Kept as a shell script (not Node) so
# it stays readable + tiny.
COPY --chown=stavr:stavr bombardment/docker/entrypoint.sh /usr/local/bin/stavr-entrypoint.sh
RUN chmod 0755 /usr/local/bin/stavr-entrypoint.sh

USER stavr

ENV STAVR_HOME=/home/stavr/.stavr \
    STAVR_PORT=7777 \
    STAVR_BIND_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 7777

# /healthz returns 200 when broker + db are live, 503 otherwise — exactly
# the shape `docker inspect` wants. `--fail` makes curl exit non-zero on
# any non-2xx so docker marks the container unhealthy without us parsing
# the body.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD curl --fail --silent --show-error \
        "http://127.0.0.1:${STAVR_PORT}/healthz" > /dev/null \
        || exit 1

VOLUME ["/home/stavr/.stavr"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/stavr-entrypoint.sh"]
