# syntax=docker/dockerfile:1
ARG FOUNDRY_BASE_IMAGE
FROM ${FOUNDRY_BASE_IMAGE}
USER root
ARG FOUNDRY_BASE_IMAGE
ARG CODEX_VERSION
RUN printf '%s' "$FOUNDRY_BASE_IMAGE" | grep -Eq '^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$' \
    && printf '%s' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    && npm install --global "@openai/codex@$CODEX_VERSION" \
    && node -e 'const [major, minor] = process.argv[1].split(".").map(Number); const actual = require("node:child_process").execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(); if (!(major > 0 || minor >= 166) || actual !== "codex-cli " + process.argv[1]) throw Error("Sandbox Codex must support Foundry v4 (>=0.166.0) and match its pin");' "$CODEX_VERSION" \
    && npm cache clean --force \
    && mkdir -p /workspace/repo /workspace/.foundry /workspace/home \
    && chown -R 1000:1000 /workspace
COPY --chown=0:0 apps/server/src/foundry/sandboxes/bootstrap.mjs /app/foundry-sandbox-bootstrap.mjs
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace/home CODEX_HOME=/run/foundry/codex T3CODE_HOME=/workspace/.foundry/t3
ENTRYPOINT ["node", "/app/foundry-sandbox-bootstrap.mjs"]
CMD ["supervise"]
