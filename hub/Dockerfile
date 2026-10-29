# dsh-mesh hub image.
#
# Network build: installs production deps from npm. For an air-gapped build, run
# `npm install --omit=dev` next to the source first and restore the two-line form:
#   COPY . .
# (the original handoff image shipped node_modules inside the build context).
FROM node:22-alpine

# Registry for the dependency layer. A version bump invalidates this layer (package.json
# changes), so every release re-downloads; hosts that cannot reach npmjs (the NAS times
# out after 20s while npmmirror answers in <1s) would stall on every build. Override with
#   docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=${NPM_REGISTRY}

COPY . .

ENV MESH_HOST=0.0.0.0 \
    MESH_PORT=8790 \
    MESH_DATA_DIR=/app/data

VOLUME ["/app/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "server.mjs"]
