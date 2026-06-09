#
# ideon.Dockerfile — Ideon MCP HTTP server (the `ideon_write` tool we wrap).
#
# Pinned to @telepat/ideon@0.1.38 (PROVENANCE.md). Runs in the PRIVATE, air-gapped
# network; our wrapper reaches it at http://ideon:3001/mcp.
#
# Serve command + flag defaults are mirrored from upstream
# (telepat/ideon/src/cli/app.ts:123-128):
#     ideon mcp serve-http --api-key <k> --host 127.0.0.1 --port 3001 --endpoint /mcp
# The default --host is 127.0.0.1 (loopback only); we MUST override to 0.0.0.0 so
# the provider container can reach it across the docker network.
#
# MCP transport is STATEFUL streamable-HTTP (telepat/ideon/src/integrations/mcp/
# httpServer.ts:41,52-54): POST /mcp `initialize` (Bearer key) -> capture the
# `Mcp-Session-Id` response header -> subsequent POST /mcp `tools/call`.
#
# Tool: `ideon_write`, required input ["idea"] (tools.ts:360-369). For the
# air-gapped smoke test the wrapper calls it with dryRun:true, which writes a
# placeholder article + meta.json under $IDEON_HOME/.ideon/output/<...> and
# contacts NO external provider (no OpenRouter/Replicate needed).

FROM node:22-bookworm-slim

# Install the pinned Ideon CLI globally. --mount caches npm between rebuilds.
RUN npm install -g --no-audit --no-fund @telepat/ideon@0.1.38

# Runtime env (overridable from compose):
#   TELEPAT_DISABLE_KEYTAR — no OS keyring in a container (would otherwise hang).
#   IDEON_HOME             — where dry-run writes .ideon/output/<ts-slug>/article-1.md.
#   IDEON_MCP_API_KEY      — Bearer key; default "changeme" matches .env.example,
#                            MUST be provided by compose for a real run.
ENV TELEPAT_DISABLE_KEYTAR=true \
    IDEON_HOME=/data/ideon \
    IDEON_MCP_API_KEY=changeme \
    IDEON_MCP_HOST=0.0.0.0 \
    IDEON_MCP_PORT=3001 \
    IDEON_MCP_ENDPOINT=/mcp

# Persist generated output across container restarts.
RUN mkdir -p /data/ideon
VOLUME ["/data/ideon"]

EXPOSE 3001

# HEALTHCHECK — drive the real MCP handshake: POST /mcp `initialize` with the
# Bearer key and the MCP-required Accept header (the streamable-HTTP transport
# answers initialize with application/json or text/event-stream). A non-error
# HTTP status (2xx) means the server is up AND the api-key is accepted. We send a
# minimal JSON-RPC initialize body; curl --fail-with-body returns non-zero on >=400
# (so a 401 bad-key or a crash both fail the check). node:22-bookworm-slim ships
# without curl, so install it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS --max-time 4 \
      -X POST "http://127.0.0.1:${IDEON_MCP_PORT}${IDEON_MCP_ENDPOINT}" \
      -H "Authorization: Bearer ${IDEON_MCP_API_KEY}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"healthcheck","version":"0"}}}' \
      >/dev/null || exit 1

# Bind 0.0.0.0 (NOT the 127.0.0.1 default) so peers on the docker network reach it.
# Shell form so the env vars expand at container start.
CMD ideon mcp serve-http \
      --api-key "$IDEON_MCP_API_KEY" \
      --host "$IDEON_MCP_HOST" \
      --port "$IDEON_MCP_PORT" \
      --endpoint "$IDEON_MCP_ENDPOINT"
