# Homelab fork brief — openGym + food tracking + remote MCP with OAuth

> **How to use this file:** copy it to the root of your openGym fork. Then add one line at the end of the existing upstream `CLAUDE.md`:
> `@HOMELAB-FORK.md`
> Claude Code then loads both files: upstream's conventions and this brief.
> Approved design: `tal054224/homelab` → `docs/projects/opengym/proposal.md`.

## Your role in this session

You are implementing the homelab fork of openGym. **Only write code and tests. Do not deploy anything, change any host, router, Tailscale or DNS setting, or add secrets to Git.** Security takes priority over convenience. If a requirement below conflicts with how upstream works, stop and ask; do not quietly weaken the requirement.

Start by reading `CLAUDE.md`, `README.md`, `ROADMAP.md`, `SECURITY.md`, `api/server.js`, `api/openapi.yaml`, `api/device-link.js`, `api/durable.js`, `api/rate-limit.js`, `mcp/README.md`, `mcp/src/`, `docker-compose.yml`, and `web/`. Then summarize the current auth, storage, and MCP data-access paths back to me before you change anything.

## Git workflow

- `origin` = my fork, `upstream` = `DuarteSantos8/openGym`. Do all work on the `homelab` branch, in small commits.
- Keep homelab changes additive and isolated: new files and modules where possible, small hooks into upstream files. This keeps upstream merges cheap.
- Keep AGPL headers and notices. Never commit `.env`, `data/`, tokens, or keys.

## Target architecture (what you're building)

```
Internet ── Tailscale Funnel ──► caddy-public (path allowlist, no secrets)
                                      │
                                      ▼
                                  mcp service  (Streamable HTTP MCP + OAuth AS, own state volume)
                                      │  internal network only, service-authenticated
                                      ▼
WireGuard/LAN ──► caddy-private ──► web (nginx) ──► api (passkeys, JSON data, food SQLite)
```

- **Public hostname:** only the MCP endpoint and the OAuth routes. **Private hostname:** the web UI and the full API, with passkeys. Passkeys never run on the public hostname.
- **mcp service:** never mounts `./data`. It reaches data only through the API.

## Work items

### 1. Food tracking (api + frontend)

- **Storage:** a new SQLite database at `${DATA_DIR}/food.sqlite`, owned only by the API.
  - Use the built-in `node:sqlite` if the Node version in `api/Dockerfile` supports it reliably; otherwise use `better-sqlite3`. Tell me which one you chose.
  - Use WAL mode, transactions, and schema migrations.
- **Model `food_log`:**

  | Field | Type and limits |
  |---|---|
  | `id` | UUID |
  | `profile_id` | required |
  | `date` | `YYYY-MM-DD`, local date |
  | `time` | optional `HH:MM` |
  | `meal` | `breakfast` \| `lunch` \| `dinner` \| `snack` |
  | `name` | 1–120 chars |
  | `quantity` | optional; > 0 and ≤ 10000 |
  | `unit` | optional enum: `g`, `ml`, `piece`, `serving`, `cup`, `tbsp`, `tsp`, `oz` |
  | `calories`, `protein_g`, `carbs_g`, `fat_g` | optional, ≥ 0 and bounded |
  | `notes` | optional, ≤ 500 chars |
  | `source` | `ui` \| `mcp` |
  | `created_at`, `updated_at`, `version` | for optimistic concurrency |
  | `idempotency_key` | optional, unique per profile |

- **Validation:**
  - Use a strict allowlist and reject unknown fields. Never pass client JSON straight into storage.
  - Bound request body size and the list page size.
- **API routes:** list by date range, get, create, update (requires matching `version`), delete, and a daily or range nutrition summary. Add them to `api/openapi.yaml`.
- **Ownership:** every query is filtered by the authenticated `profile_id`. Return 404 for objects owned by another profile, not 403.
- **Frontend:** a minimal food log page (add, edit, delete, and daily totals) that follows the existing UI patterns.

### 2. Service-to-service auth (mcp → api)

- **Calls:** the mcp service calls the API with a shared secret, read from a file path in `MCP_SERVICE_TOKEN_FILE`, plus the `profile_id` resolved from the OAuth token.
  - Compare the secret in constant time.
  - Accept service auth only on an explicit list of routes.
- **Route list:** the service may call read routes for all openGym data, plus the food create, read, update, and delete routes only. Any other write route called with service auth returns 403, **enforced in the API** and not only in the MCP.
- **Link-code redemption:** an internal endpoint, also secured with service auth, redeems a link code and returns its `profile_id`.

### 3. OAuth link codes (api + frontend)

- **Generating a code:** in the private UI, a logged-in user generates an "MCP link code".
  - The code is single-use, expires after 5 minutes, and has at least 128 bits of entropy (or 8+ characters plus strict rate limits).
  - Only a hash of the code is stored.
- Reuse the patterns in `device-link.js` and `rate-limit.js` where they fit.
- **Connected apps:** the UI lists them as `client_name`, created-at, and last-used, with a revoke button that calls the mcp revoke endpoint over service auth.

### 4. Remote MCP server (`mcp/`)

- **Transport and SDK:**
  - Add Streamable HTTP transport using the official `@modelcontextprotocol/sdk` (pin the exact version).
  - Keep the stdio mode working for local use, or remove it on purpose. Either way, tell me which.
- **Data access:** replace any direct file reads with calls to the API (item 2).
- **Tools:**

  | Tool | Kind | Annotations |
  |---|---|---|
  | Existing read tools | read | `readOnlyHint: true` |
  | `list_food_logs`, `get_food_log`, `get_nutrition_summary` | read | `readOnlyHint: true` |
  | `create_food_log` | write | — |
  | `update_food_log` | write | — |
  | `delete_food_log` | write | `destructiveHint: true` |

  - Tool inputs use strict schemas that match the API limits.
  - Do not add any generic patch, raw-JSON, file, shell, or URL-fetch tools.
  - Tool outputs must not echo tokens or internal errors.
- **Hardening:**
  - Validate the `Origin` header on HTTP requests.
  - Listen on `0.0.0.0` inside the container. The port is published only to the edge network, not to the host.
  - Set request size limits and per-token rate limits.

### 5. OAuth 2.1 authorization server (inside `mcp/`)

Follow the latest MCP authorization spec, and use the SDK's auth helpers (for example its auth router and bearer middleware) where the pinned version provides them. Before building on any helper, verify it exists in that version.

- **Metadata:**
  - Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource`, with `resource` set to `PUBLIC_BASE_URL + "/mcp"`.
  - Authorization Server Metadata (RFC 8414).
  - An unauthenticated `/mcp` request returns `401` with a `WWW-Authenticate` header containing `resource_metadata`.
- **Flow:** Authorization Code with **PKCE S256 only**. Reject `plain` PKCE and the implicit and password grants. Require the `resource` parameter, and bind the token audience to it.
- **Client registration:** support whatever Spark actually uses. Implement Dynamic Client Registration, and Client ID Metadata Documents if the SDK supports them.
  - Rate-limit registration and cap the total number of clients.
  - Redirect URIs must be HTTPS. If `ALLOWED_REDIRECT_HOSTS` is set, it is a strict allowlist; empty means log-and-allow, which is used only during the compatibility test.
  - Match redirect URIs exactly.
- **`/authorize` consent page:**
  - Server-rendered, with a strict CSP, no third-party assets, and `frame-ancestors 'none'`.
  - Shows the client name and redirect host, and asks for the link code.
  - Uses CSRF protection and rate-limits by IP and by client.
- **Tokens:**
  - Opaque random tokens; store only their hashes.
  - Access tokens live at most 15 minutes. Refresh tokens rotate on every use; reusing an old one revokes the whole family.
  - Each token stores `client_id`, `profile_id`, `scopes`, `audience`, and `expiry`.
  - Scopes are `opengym:read` and `food:write`; each tool checks for its scope.
- **Revocation:** a `/revoke` endpoint, plus revoking all tokens on demand through service auth.
- **Storage:** a separate SQLite file in `MCP_STATE_DIR` (not `./data`).
- **Logging:** record the event type, client ID, and outcome only. Never log tokens, codes, food contents, or prompts.

### 6. Containers and CI

- **Images:** add `mcp/Dockerfile`. All images must:
  - run as a non-root user,
  - work with a read-only root filesystem (writable `tmpfs` paths or volumes only where needed),
  - pin base images by digest.
- **Compose:** add a `docker-compose.homelab.yml` example with:
  - no host ports except the caddy services,
  - `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and `read_only: true`,
  - separate networks for the public edge, the private edge, and internal traffic (`internal: true`),
  - no Docker socket and no host networking.
- **Caddy config:** provide `Caddyfile.public` with a path allowlist where everything else returns 404, and `Caddyfile.private`.
- **CI:** a workflow that runs all test suites, then builds and pushes `ghcr.io/<me>/opengym-{api,web,mcp}`, tagged with the commit SHA. It must print the image digests. Do not publish `:latest`.

## Acceptance tests (must exist and pass)

1. **Food API:** create, read, update, and delete work; unknown fields are rejected; out-of-bounds values are rejected; a version conflict returns 409; repeating an idempotency key does not create a duplicate; and another profile's object returns 404.
2. **Service auth:**
   - Missing or wrong secret → 401.
   - A non-food write route → 403.
   - Valid calls succeed.
3. **OAuth and MCP:**
   - Protected-resource and authorization-server metadata endpoints return the correct JSON.
   - Unauthenticated `/mcp` → 401 with `WWW-Authenticate`.
   - Missing PKCE, `plain` PKCE, a wrong verifier, a redirect URI mismatch, or a missing `resource` parameter → rejected.
   - An expired, used, or wrong link code → rejected; repeated attempts get rate-limited.
   - A wrong-audience, expired, or revoked token → 401.
   - Reusing a refresh token revokes the token family.
   - A token missing the `food:write` scope cannot write.
   - A token for profile A cannot read profile B's data.
4. **MCP tools:** every tool works end to end against a test API. The tool list contains no non-food write tools.
5. **Concurrency:** parallel food writes produce no lost updates. Existing upstream tests still pass.

## Done means

All tests pass. `docker compose -f docker-compose.homelab.yml up` works locally with synthetic data. CI produces pinned images. You give me a short summary of:

- the files you changed,
- the SDK and SQLite choices,
- the client-registration modes you implemented,
- any security trade-offs you made.

I'll bring that summary to the homelab repo for the final Blue Hat review.
