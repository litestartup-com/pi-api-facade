# pi-api-facade — one container = one standalone Pi API node.
#
# THIN runtime image by design (deployment red line): nginx, the demo BFFs and
# KB seeds never enter this image — they are separate compose services. The
# manager-side node image (planned dac-node-pi) reuses this exact image.
#
# Build from the repo root (compose does this for you):
#   docker build -f docker/Dockerfile -t pi-api-facade .
# Building in China:
#   --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

# git: the per-run audit hook + workspace tooling; ripgrep/bash: Pi's built-in
# tools shell out to them; curl: healthcheck; tzdata: TZ-aware logs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl ripgrep bash tzdata \
    && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmjs.org

# Dependency surface first (layer cache): the Pi SDK is pinned exact in the
# committed lockfile, so `npm ci` materializes a reproducible tree and code
# edits never invalidate this layer.
COPY package.json package-lock.json README.md README.zh.md LICENSE /opt/pi-api-facade/
RUN cd /opt/pi-api-facade \
    && npm ci --omit=dev --registry="${NPM_REGISTRY}" --no-audit --no-fund \
    && npm cache clean --force

# The facade runs its TypeScript sources directly (Node type stripping; no
# build step). src/ + docs are small; keep them after node_modules for caching.
COPY tsconfig.json /opt/pi-api-facade/
COPY src /opt/pi-api-facade/src/
COPY docs /opt/pi-api-facade/docs/

COPY docker/entrypoint.sh /usr/local/bin/pi-facade-entrypoint
RUN chmod +x /usr/local/bin/pi-facade-entrypoint \
    && mkdir -p /data /workspace \
    && chown -R 1000:1000 /data /workspace \
    # compose passes the host deploy uid (user: ${HOST_UID}); a fixed baked
    # owner would only work for uid 1000 by coincidence. Volume root 777 lets
    # any uid work in the subtree it creates (single-tenant node container).
    && chmod 777 /data

# PI_AGENT_DIR is a mounted volume: sessions, auth.json, models.json and
# settings all live per-node (one volume per node — never share between nodes).
# The facade binds 0.0.0.0 INSIDE the compose network; its port is not
# published — nginx is the only front door.
ENV PI_FACADE_ENGINE=sdk \
    PI_AGENT_DIR=/data/agent \
    PI_FACADE_HOST=0.0.0.0 \
    PI_FACADE_PORT=3091 \
    HOME=/data \
    NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /workspace
EXPOSE 3091
HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=20s \
    CMD curl -fsS http://127.0.0.1:3091/api-gw/v1/health || exit 1
ENTRYPOINT ["pi-facade-entrypoint"]
