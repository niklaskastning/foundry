# syntax=docker/dockerfile:1
FROM node:26.12.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global vite-plus@1.4.0
WORKDIR /src
ARG FOUNDRY_REVISION
RUN printf '%s' "$FOUNDRY_REVISION" | grep -Eq '^[a-f0-9]{40}$' \
    && git init . \
    && git remote add origin https://github.com/niklaskastning/foundry.git \
    && git fetch --depth=1 origin "$FOUNDRY_REVISION" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$FOUNDRY_REVISION"
RUN vp install --frozen-lockfile
RUN FOUNDRY_ARCHIVE_REVISION="$FOUNDRY_REVISION" vp run foundry:build server
RUN node --input-type=module -e 'import fs from "node:fs"; const m = JSON.parse(fs.readFileSync("apps/server/dist/foundry-build.json", "utf8")); if (m.repository !== "niklaskastning/foundry" || m.revision !== process.argv[1] || m.dirty !== false) throw new Error("Unverified Foundry build provenance");' "$FOUNDRY_REVISION"
# The production subset intentionally excludes patches for mobile and build tools.
RUN npx --yes pnpm@12.14.0 --config.allow-unused-patches=true --filter t3 deploy --prod --legacy /output

FROM node:26.12.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates libsecret-1-0 tini && rm -rf /var/lib/apt/lists/*
ARG FOUNDRY_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/niklaskastning/foundry" \
      org.opencontainers.image.revision=$FOUNDRY_REVISION
ENV NODE_ENV=production T3CODE_HOME=/var/lib/foundry T3CODE_TELEMETRY_ENABLED=false T3CODE_DISABLE_AUTO_UPDATE=1 T3CODE_HOSTED_APP_URL=https://foundry.heavenforgeprod.com
WORKDIR /app
COPY --from=build --chown=node:node /output/ ./
RUN mkdir -p /var/lib/foundry /workspaces && chown node:node /var/lib/foundry /workspaces
USER node
EXPOSE 3773
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/bin.mjs", "--host", "0.0.0.0", "--port", "3773", "--no-browser"]
