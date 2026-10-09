# Remote MCP service (homelab fork). Build context is the repository root: the tools import
# the same pure training-logic helpers the app uses from frontend/src/lib.
#   docker build -f mcp/Dockerfile .
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

RUN apk upgrade --no-cache
WORKDIR /app/mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY mcp/src ./src
COPY mcp/scripts ./scripts
COPY frontend/src/lib /app/frontend/src/lib
# The consent page's attempt throttle reuses the API's dependency-free backoff helper.
COPY api/rate-limit.js /app/api/rate-limit.js
RUN mkdir -p /state && chown node:node /state

ENV NODE_ENV=production MCP_MODE=http PORT=3001 INTERNAL_PORT=3002 MCP_STATE_DIR=/state
USER node
VOLUME ["/state"]
EXPOSE 3001
HEALTHCHECK --interval=1m --timeout=5s --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${INTERNAL_PORT}/internal/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/http.js"]
