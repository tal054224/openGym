# Homelab fork — implementation plan

Companion to [HOMELAB-FORK.md](../../HOMELAB-FORK.md) (the brief). This file is the build order,
the design decisions and the test map. Work on branch `homelab`, one commit per step in §4.

---

## 0. Verified facts (checked 2026-10-09, not assumed)

| Fact | Evidence |
|---|---|
| `api/Dockerfile` runs `node:22-alpine` → today **v22.23.3**, index digest `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` | `docker run node:22-alpine` |
| Local dev Node is v26.4.0 | `node --version` |
| `@modelcontextprotocol/sdk` latest = **1.32.1**. Ships `server/streamableHttp.js`, `server/auth/router.js` (`mcpAuthRouter`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`), `server/auth/provider.js` (`OAuthServerProvider`), handlers `authorize/token/register/revoke/metadata`, `middleware/bearerAuth.js` (`requireBearerAuth` with `expectedResource` + `resourceMetadataUrl`). All express-based; express 5 + express-rate-limit are SDK deps. | installed in `/tmp/sdkprobe` |
| SDK v2 (`@modelcontextprotocol/server` 2.3.1 + `@modelcontextprotocol/express` 2.0.2) **dropped the authorization-server helpers** (only bearer auth, metadata router, origin/host validation remain). | export list of v2 express pkg |
| SDK 1.32.1 authorize schema: `code_challenge_method: z.literal('S256')` (plain/missing rejected), `resource` **optional**. Token handler verifies PKCE locally. `redirectUriMatches` = exact match, except port relaxation for loopback hosts. | `handlers/authorize.js`, `handlers/token.js` |
| SDK 1.32.1 has **no server-side Client ID Metadata Document support** (only the `client_id_metadata_document_supported` schema field). | grep of dist |
| SDK client auth (`middleware/clientAuth.js`) compares `client_secret` in plaintext against `clientsStore.getClient()`. | `register.js`, `clientAuth.js` |
| Repo: on `main`, only `origin` (= `tal054224/openGym`), **no `upstream` remote**, no `homelab` branch yet. | `git remote -v` |

### Decisions that follow

- **Food storage:** food entries and goals are server-managed fields in each profile's existing
  `state-<uid>.json`. No second database or dependency. The API's normal atomic state writer bumps
  `_rev` / `_wid`; generic state sync hides those fields from clients and preserves them on every
  workout push. The app's explicit full reset clears them. Food remains available through the
  authenticated food routes and MCP's service-authenticated food routes.
- **SDK:** pin `@modelcontextprotocol/sdk` **exactly `1.32.1`** (v1 is the only line with the
  OAuth AS helpers). Also pin `express` exactly to the version the SDK resolves (we import it
  directly, so declare it). zod stays `^3.25`-compatible → pin exact `3.25.x`.
- **Client registration:** Dynamic Client Registration only. CIMD is not supported by the SDK →
  not implemented (report this).

---

## 1. Current state summary (brief asked for this before any change)

**Auth (api/server.js).** No framework; `routes['METHOD /path']` lookup in the `http.createServer`
dispatcher (~L2543). Only parameterised path today is `/api/media/{hash}` (regex → template key).
Session = HMAC-signed `uid:exp:sv` (secret in `DATA_DIR/secret`) carried as `__Host-` cookie or as
`Authorization: Bearer` (paired mobile app). `sessionOf(req)` / `readSession(req)` resolve the user;
`sv` bump = "sign out everywhere". `csrfOk()` (~L631) passes GET/HEAD, Bearer, `Sec-Fetch-Site:
same-origin|none`, or no `Origin`. Sensitive account actions require `proveOwner(req,res,user,body,act)`
(fresh passkey/password proof). Throttles from `rate-limit.js`: `createBackoff` (exponential after N
free failures) and `createWindow` (fixed window); used as `AUTH_BURST`, `ADDR_FAILS`, `ACCOUNT_FAILS`.
**There is no `profile_id` concept — a profile is a user; `profile_id` := `user.id`.**

**Storage.** `DATA_DIR/db.json` (users, creds, subs, invites, `deviceLinks`) and
`DATA_DIR/state-<uid>.json` (whole training state, `_rev` counter), written via
`durable.js#atomicWrite` (tmp → fsync → rename → fsync dir). `readBody` caps at 5 MiB (`MAX_BODY`).

**Device links (device-link.js).** 12 chars from a 32-char alphabet (~60 bits), 10 min TTL, one per
user, only `sha256('opengym-link:'+code)` stored in `db.deviceLinks`, timing-safe lookup, burned
separately; wrong codes strike `ADDR_FAILS` under kind `link`. Creation requires `proveOwner`.

**MCP (mcp/src).** stdio only (`McpServer` + `StdioServerTransport`), SDK `^1.0.4`, zod `^3.23.8`.
`state.js` reads `OPENGYM_DATA/db.json` + `state-<uid>.json` **directly from disk** (fs.watch cache),
uid from `OPENGYM_UID` or auto-detect. `tools.js`: 9 read tools, each calls `getState()` synchronously
and derives answers via `frontend/src/lib/*` (relative imports). No auth, no network.

---

## 2. Open decisions — defaults chosen, override before implementation if you disagree

| # | Question | Default (what the plan assumes) |
|---|---|---|
| D1 | stdio mode | **Keep** stdio for local use with its existing file source (upstream path unchanged). The container runs only `src/http.js`, never mounts `./data`, and in HTTP mode the file source is hard-disabled. Food tools exist only in HTTP mode (food lives in the API's normal per-profile state document). |
| D2 | MCP link-code generation requires fresh passkey proof (`proveOwner`) like device-link? | **Yes** — it grants data access to a third party. |
| D3 | DCR client auth methods | Accept `none` (public + PKCE) **and** `client_secret_post`. Secrets stored as SHA-256 only (see §3.6 for how, given the SDK's plaintext compare). |
| D4 | `resource` on refresh-token requests | Required on authorize + code exchange. On refresh: if present must equal the family's audience; if absent, the bound audience is used (compat). Flag `MCP_STRICT_RESOURCE=1` makes it mandatory everywhere. |
| D5 | Where the Food page lives | Route `/food`, entry card on Home + row in Settings; **tab bar unchanged** (already 5 tabs). |
| D6 | API egress | `api` gets an extra non-internal `egress` network (no ports) so Web Push keeps working; `mcp` has **no** egress. |
| D7 | Image arch | `linux/amd64` only (add arm64 if the homelab box is ARM). |
| D8 | Secret direction | One shared secret file used both ways (mcp→api, api→mcp). |
| D9 | Food translations | English strings added to `en`; other locales get real translations so `check-locales` passes. |

---

## 3. Design

### 3.1 Food storage — `api/food-store.js` (new)

- Food records live in `foodLogs` and `nutritionGoals` inside the existing
  `DATA_DIR/state-<uid>.json`, alongside the profile's routines and workouts. The existing profile
  file is the app's native persistent store; no separate SQLite file, migration, or package.
- `food-store.js` takes `readState` / `writeState` callbacks. The API's `writeFoodState` uses the
  existing durable temp-write + fsync + rename helper, increments `_rev`, rotates `_wid` / `_wids`,
  and invalidates the state cache. All operations are synchronous on the server event loop.
- The food properties are server-managed: `forClient` omits them from generic `GET /api/data`, and
  `PUT /api/data` restores them from the stored document after its revision check (or removes them
  on an explicit `resetAt`). This keeps stale device pushes from replacing them. The web and mobile
  food views call the authenticated food routes directly; MCP calls those same routes under
  service auth.
- Every stored record has a UUID, owner-by-container (`state-<uid>`), local calendar date, optional
  time, meal/name/quantity/unit/macros/notes, `source`, created/updated timestamps, version, and
  optional idempotency key/hash. Nutrition goals are a nullable per-profile object in the same file.

### 3.2 Food validation + routes — `api/food.js` (new) + small hooks

- `validateCreate(body)`, `validatePatch(body)`: strict allowlist; **any unknown key → 400**
  `{error:'unknown field', field}`. Types exact (numbers must be finite numbers, not strings).
  `name`/`notes` trimmed, control chars rejected. `date` = real calendar date, year 2000–2100.
  `time` `^([01]\d|2[0-3]):[0-5]\d$`. `idempotency_key` `^[A-Za-z0-9._:-]{1,100}$`.
  `source` is **never** taken from the body: `ui` for session auth, `mcp` for service auth.
- Body size: give `readBody(req, max = MAX_BODY)` an optional cap (1-line hook); food routes use
  16 KiB.
- Write rate limit: `createWindow({max:120, windowMs:60_000})` keyed by profile.
- Routes (registered via `...foodRoutes({ json, readBody, readSession, HttpError })` next to
  `coachRoutes` — one line). Dispatcher gets a second path-param regex
  `^/api/food/([0-9a-f-]{36})$` → key `METHOD /api/food/{id}` (same pattern as media).

| Route | Behaviour |
|---|---|
| `GET /api/food?from&to&limit&cursor` | range ≤ 366 days, `limit` 1–200 (default 100), keyset cursor `(date,time,created_at,id)`; returns `{items, next_cursor}` |
| `GET /api/food/{id}` | 404 if missing **or other profile** |
| `POST /api/food` | 201 + item. Same `idempotency_key` + same payload → 200 with the original item; same key + different payload → 409 `idempotency-key-reuse` |
| `PATCH /api/food/{id}` | body must include `version` (int ≥1); partial fields, `null` clears an optional field. `UPDATE … WHERE id=? AND profile_id=? AND version=?` → 0 rows: 404 if not owned/missing else 409 `{error:'version conflict', current}` |
| `DELETE /api/food/{id}?version=N` | `version` optional; if given must match (409). 204 on success |
| `GET /api/food/summary?from&to` | per-day + range totals of kcal/P/C/F and `entries`, `entries_missing_calories` |

- Concurrency: each compare/version/mutate/write is synchronous on the Node event loop, so only one
  same-version update can win. Durable file writes use the app's existing atomic replacement.
- `api/openapi.yaml`: new tag `Food`, schemas `FoodLog`, `FoodLogCreate`, `FoodLogPatch`,
  `NutritionSummary`, all `additionalProperties: false`; regenerate via
  `node scripts/build-api-docs.mjs` (CI runs `--check`).

### 3.3 Service auth (mcp → api) — `api/service-auth.js` (new)

- Env `MCP_SERVICE_TOKEN_FILE`. Unset → feature off (any request carrying the header → 401).
  Set but unreadable or < 32 bytes after trim → **refuse to boot** (fail closed).
- Headers: `X-OpenGym-Service-Token: <secret>`, `X-OpenGym-Profile: <uid>`. Distinct from
  `Authorization: Bearer`, so `sessionOf` never confuses the two.
- Compare: `timingSafeEqual(sha256(given), sha256(secret))` (no length leak).
- Allowlist (enforced **in the API dispatcher**, before the handler):

```js
export const SERVICE_ROUTES = {
  'GET /api/data': 'profile', 'GET /api/data/rev': 'profile',
  'GET /api/food': 'profile', 'GET /api/food/summary': 'profile', 'GET /api/food/{id}': 'profile',
  'POST /api/food': 'profile', 'PATCH /api/food/{id}': 'profile', 'DELETE /api/food/{id}': 'profile',
  'POST /api/internal/mcp/link-code/redeem': 'none',   // service-only, no profile
};
```

- Dispatcher hook (right after `routes[key]` lookup, before `csrfOk`):
  1. header absent → normal path (and `/api/internal/*` routes → 404 for non-service callers).
  2. header present + any cookie or `Authorization` also present → 400 (no mixed credentials).
  3. bad/absent secret → 401. Route not in `SERVICE_ROUTES` → **403**.
  4. `'profile'` routes: `X-OpenGym-Profile` must match `^[A-Za-z0-9_-]{1,64}$` and an existing,
     non-disabled user → else 401. Sets `req.service = { user }`.
- `sessionOf(req)`: first line `if (req.service) return req.service.user ? { user: req.service.user, exp: Infinity, bearer: true, service: true } : null;`
  so existing read handlers work unchanged.
- `GET /api/data` under service auth skips `notePull(user)` (an MCP read is not the user opening the
  app; keeps nudges/admin "last seen" honest).
- Audit: `service.call` only for denials (401/403), never bodies.
- Defense in depth: nginx `/api` locations and both Caddyfiles strip `X-OpenGym-*` request headers,
  so the private UI path can never carry service auth.

### 3.4 MCP link codes + connected apps (api) — `api/mcp-link.js` (new)

- `makeMcpLinkCode()`: 26 chars from the same 32-char alphabet = **130 bits**, shown as
  `XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`. Stored as `sha256('opengym-mcp-link:'+clean(code))` in
  `db.mcpLinks[] = {h, userId, exp, created}`; TTL **5 min**; one live code per user (new replaces old).
  Reuses `device-link.js` structure (prune / timing-safe find / burn).
- `POST /api/account/mcp-link` (session + `proveOwner(…,'mcp-link')`, D2) → `{code, expires}`; audit
  `mcp.link.create`.
- `POST /api/internal/mcp/link-code/redeem` (service-only) `{code}` → `{profile_id}` and **burn in the
  same tick** before `saveDb()`; failure → 404 `{error:'invalid code'}` + strike a global
  `createBackoff` key `mcp-redeem` (free 50, then backoff) so even a compromised mcp can't grind codes.
  Audit `mcp.link.redeem` ok/fail.
- Connected apps (API → mcp internal, env `MCP_INTERNAL_URL`, same secret D8; routes 404 when unset):
  - `GET /api/account/mcp-apps` → mcp `GET /internal/connections?profile_id=` → `[{client_id, client_name, created_at, last_used_at, scopes}]`
  - `POST /api/account/mcp-apps/revoke` `{client_id}` or `{all:true}` → mcp `POST /internal/revoke`
  - 5 s timeout, errors mapped to 502 `{error:'mcp unavailable'}`.

### 3.5 Remote MCP server (mcp/)

New files (upstream files touched minimally):

| File | Purpose |
|---|---|
| `mcp/src/config.js` | env parsing: `PUBLIC_BASE_URL` (https required unless `NODE_ENV=test`), `API_INTERNAL_URL`, `MCP_SERVICE_TOKEN_FILE`, `MCP_STATE_DIR`, `ALLOWED_REDIRECT_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_MAX_CLIENTS` (50), `PORT` (3001), `INTERNAL_PORT` (3002), `TRUST_PROXY_HOPS` (1) |
| `mcp/src/api-client.js` | `fetch` wrapper → API with service headers; 10 s timeout; maps status → fixed codes `NOT_FOUND / CONFLICT / INVALID(field) / UNAVAILABLE`; never forwards raw bodies except the allowlisted `field` name |
| `mcp/src/request-context.js` | `AsyncLocalStorage` holding `{profileId, scopes, state}` per MCP request |
| `mcp/src/state.js` (hook) | `getState()` returns `als.getStore().state` when a store exists; when `MCP_MODE=http` and no store → throw (file reads impossible). `tools.js` stays untouched. |
| `mcp/src/food-tools.js` | `list_food_logs`, `get_food_log`, `get_nutrition_summary` (`readOnlyHint:true`), `create_food_log`, `update_food_log`, `delete_food_log` (`destructiveHint:true`). zod schemas `.strict()` mirroring §3.2 limits exactly. `create_food_log` auto-generates an `idempotency_key` if none given. |
| `mcp/src/mcp-server.js` | `buildServer({scopes})`: new `McpServer` per request; registers existing `TOOLS` with `annotations:{readOnlyHint:true}`, food read tools, and food write tools **only if** `food:write` ∈ scopes; every handler re-checks its scope (`opengym:read` / `food:write`) → `isError` `INSUFFICIENT_SCOPE` |
| `mcp/src/http.js` | entrypoint (two express apps, see below) |
| `mcp/src/oauth/*` | §3.6 |

`http.js` — **public app** (port 3001, behind caddy-public):
- `app.set('trust proxy', TRUST_PROXY_HOPS)`, `x-powered-by` off, global security headers.
- Host check (must equal `PUBLIC_BASE_URL` host) + Origin check (if `Origin` present it must be in
  `MCP_ALLOWED_ORIGINS`, default `[PUBLIC_BASE_URL origin]`) → 403.
- `mcpAuthRouter(...)` + root alias `GET /.well-known/oauth-protected-resource` (in addition to the
  SDK's `/.well-known/oauth-protected-resource/mcp`), both with `resource = PUBLIC_BASE_URL + '/mcp'`.
- `POST /mcp`: `express.json({limit:'64kb'})` → `requireBearerAuth({verifier, expectedResource, resourceMetadataUrl})`
  → per-token rate limit (`express-rate-limit`, key = token hash, 120/min) → load state via
  `GET /api/data` (cached per profile, revalidated with `GET /api/data/rev`, 5 s TTL) →
  `als.run(ctx, …)` → `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` (stateless)
  → `server.connect` → `transport.handleRequest(req,res,req.body)`; close both on `res.close`.
  State fetch is lazy (only for non-food tools) to avoid a full-state pull per food call.
- `GET/DELETE /mcp` → 405 (stateless). Anything else → 404.
- Listen `0.0.0.0`.

**internal app** (port 3002, internal network only): service-token auth (same compare as api),
`GET /internal/connections?profile_id=`, `POST /internal/revoke {profile_id, client_id?|all}`,
`GET /internal/health`.

### 3.6 OAuth 2.1 AS (mcp/src/oauth/)

- `store.js` — `node:sqlite` at `MCP_STATE_DIR/oauth.sqlite` (WAL, migrations like §3.1):
  - `clients(client_id PK, client_name, redirect_uris JSON, auth_method, secret_hash, created_at, last_used_at)`
  - `pending_auth(id PK, client_id, redirect_uri, scopes, state, code_challenge, resource, browser_hash, csrf_hash, exp)` (10 min)
  - `auth_codes(code_hash PK, client_id, profile_id, scopes, resource, redirect_uri, code_challenge, exp, used_at)` (60 s)
  - `families(id PK, client_id, profile_id, scopes, audience, created_at, last_used_at, revoked_at)`
  - `tokens(token_hash PK, family_id, kind 'access'|'refresh', exp, used_at, revoked_at)`
  - Hash = SHA-256 of 256-bit random (base64url) tokens/codes. Periodic prune.
- `clients-store.js` (`OAuthRegisteredClientsStore`):
  - `registerClient`: cap `MCP_MAX_CLIENTS` (→ `TooManyRequests`/`invalid_client_metadata`);
    every redirect URI must be `https:` (reject `http:` incl. loopback, so SDK's loopback port
    relaxation never applies), no fragment, no userinfo; if `ALLOWED_REDIRECT_HOSTS` set → strict
    host allowlist; if empty → allow + log `{event:'dcr.redirect_host', host}`.
    `client_name` ≤ 100 chars, stripped of control chars (it is rendered on the consent page).
    `grant_types` ⊆ `authorization_code, refresh_token`; `response_types` = `code`.
  - Confidential clients (D3): store `secret_hash`; `getClient()` returns the record **without**
    `client_secret` so the SDK's plaintext compare is skipped, and a small `confidentialClientAuth`
    middleware mounted **before** `mcpAuthRouter` on `/token` + `/revoke` verifies
    `sha256(client_secret)` timing-safely for clients with `auth_method='client_secret_post'`
    (401 `invalid_client` otherwise). Covered by tests.
  - Registration rate limit via SDK option `clientRegistrationOptions.rateLimit` (10/hour/IP).
- `provider.js` (`OAuthServerProvider`):
  - `authorize(client, params, res)`: require `params.resource` === `PUBLIC_BASE_URL/mcp` (else
    redirect `error=invalid_target`); scopes ⊆ {`opengym:read`,`food:write`} (else `invalid_scope`;
    empty → `opengym:read`); create `pending_auth`; set `__Host-og_consent` cookie (random, its hash in
    the row; `Secure; HttpOnly; SameSite=Lax; Path=/`); render consent page.
  - `challengeForAuthorizationCode`: from `auth_codes` (unused, unexpired).
  - `exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource)`: atomically mark
    used (`UPDATE … WHERE used_at IS NULL` → 0 rows = replay → revoke any family issued from it);
    check client, `redirect_uri` exact equality, `resource` present and equal (D4); issue
    access (15 min) + refresh (30 d, family absolute 90 d).
  - `exchangeRefreshToken`: look up by hash; if already `used_at` → **revoke whole family** + 
    `invalid_grant`; else mark used, issue new pair in same family; scopes may only narrow.
  - `verifyAccessToken`: hash lookup, not revoked, family not revoked, not expired →
    `AuthInfo {token, clientId, scopes, expiresAt, resource: new URL(audience), extra:{profileId}}`.
    Bearer middleware enforces `expectedResource` (wrong audience → 401).
  - `revokeToken`: revoke token's family (RFC 7009: always 200).
- `consent.js` — `GET` render (from `authorize`) and `POST /authorize/consent`:
  - Page: server-rendered, **no JS**, inline CSS via hash; headers
    `Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; form-action 'self' <redirect-origin>; frame-ancestors 'none'; base-uri 'none'`
    (redirect origin needed because Chrome applies `form-action` to the post-submit redirect),
    `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
    Shows escaped `client_name`, redirect **host**, requested scopes (food:write as an opt-out
    checkbox), link-code input.
  - POST checks: `Sec-Fetch-Site` same-origin (or `Origin` = public origin), cookie hash matches
    `pending_auth.browser_hash`, hidden `csrf` = HMAC(pending id) matches, pending not expired.
  - Rate limits: `createBackoff`-style (copied minimal impl, or `express-rate-limit`) by IP (5 free
    failures then backoff) and by client_id (20 attempts/hour); success clears IP counter.
  - Redeem via api-client `POST /api/internal/mcp/link-code/redeem`; on success delete pending, create
    auth code, `303` to `redirect_uri?code=…&state=…&iss=…`. "Deny" button → `error=access_denied`.
- `log.js` — `log(event, {client_id, outcome})` JSON line to stdout. Nothing else is ever logged
  (no tokens, codes, IPs beyond rate-limit memory, food data, tool args).

### 3.7 Frontend

- `src/lib/food.js` (+ `food.test.js`): pure helpers — `validateFoodDraft` (mirrors API limits),
  `dayTotals(items)`, `groupByMeal(items)`, `toPatch(original, edited)`; API calls via existing
  `api()` from `lib/api.js` (`listFood`, `createFood`, `patchFood`, `deleteFood`, `foodSummary`).
- `src/views/Food.jsx`: date switcher (‹ today ›), meals grouped (`Section`/`Row` from
  `components/ui.jsx`), daily totals card, add/edit in a sheet (`TextField`, `Segmented` for meal,
  select for unit), delete with confirm; 409 → reload item + toast "changed elsewhere". Signed-in
  only (`if (!user) return <Navigate to="/home"/>`; hidden for guest/DEMO).
- `App.jsx`: `<Route path="/food">`; Home card + Settings row (D5).
- Settings → Account page (`components/McpConnect.jsx`): `McpLinkRow` + `McpLinkSheet` (copy of
  `DeviceLinkSheet` flow: proof → code + copy + 5-min countdown, no QR) and `ConnectedAppsSheet`
  (list name/created/last used, Revoke, Revoke all). Shown only when `/api/config` reports
  `mcp: true` (API adds this flag when `MCP_INTERNAL_URL` + token file are configured).
- Locales: new strings in all locale files (D9); `npm run check:locales` and
  `check:source-strings` must pass.

### 3.8 Containers, compose, Caddy, CI

- **Pin by digest**: `node:22-alpine@sha256:0a7108bf…e402` in api/web/mcp Dockerfiles; nginx and
  caddy digests resolved at implementation time (`docker buildx imagetools inspect`).
- `api/Dockerfile`: add stage `homelab` **between** `coach` and `default` (default must stay last):
  same as default + `USER node`, `CMD ["node","--disable-warning=ExperimentalWarning","server.js"]`.
- `web/Dockerfile`: add `homelab` stage before the final one, based on
  `nginxinc/nginx-unprivileged:alpine@sha256:…` (listens 8080, non-root, pid/temp in tmpfs).
  nginx template strips `X-OpenGym-*` headers on `/api` (`proxy_set_header … ""`).
- `mcp/Dockerfile` (new, build context = repo root because tools import `frontend/src/lib`):
  `npm ci --omit=dev` in mcp, copy `mcp/src` + `frontend/src/lib` (+ whatever `check:node-loadable`
  shows is needed), `USER node`, `CMD node --disable-warning=ExperimentalWarning src/http.js`,
  `VOLUME /state`, healthcheck via `node -e fetch('http://127.0.0.1:3002/internal/health')`.
- `docker-compose.homelab.yml`:
  - networks: `edge_public`, `edge_private`, `internal` (`internal: true`), `egress` (api only, D6).
  - `caddy-public` (edge_public; host port bound to `127.0.0.1:${PUBLIC_PORT}` for Funnel),
    `caddy-private` (edge_private; host port bound to `${PRIVATE_BIND_IP}:443`),
    `web` (edge_private + internal), `api` (internal + egress), `mcp` (edge_public + internal).
  - every service: `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
    `user:` non-root, tmpfs for `/tmp` (+ nginx/caddy runtime dirs), no docker socket, no host net.
  - secrets: `secrets: mcp_service_token: file: ./secrets/mcp_service_token` mounted into api + mcp;
    `MCP_SERVICE_TOKEN_FILE=/run/secrets/mcp_service_token`.
  - volumes: `./data:/data` (api only), `mcp-state:/state` (mcp only), media read-only (web).
  - `media` downloader kept as an opt-in profile (`profiles: [setup]`) on `egress`.
- `Caddyfile.public`: `request_header -X-OpenGym-*`; `request_body max_size 64KB`; allowlist
  `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server`, `/authorize`,
  `/authorize/consent`, `/token`, `/register`, `/revoke`, `/mcp` → `reverse_proxy mcp:3001`;
  `respond 404` for everything else. HSTS + nosniff headers.
- `Caddyfile.private`: TLS (cert paths via env/placeholders), strip `X-OpenGym-*`, everything →
  `web:8080`. No MCP/OAuth routes.
- `.github/workflows/homelab.yml` (push to `homelab`, manual dispatch):
  - job `test`: Node 22, frontend `npm ci && npm test && check-locales && check-source-strings`,
    api `npm ci --omit=optional && npm test && build-api-docs --check`, mcp `npm ci && npm test`.
  - job `images` (needs test; `permissions: {contents: read, packages: write}`): actions pinned by
    commit SHA; `docker/login-action` with `GITHUB_TOKEN`; three `docker/build-push-action` steps
    (`target: homelab` for api/web) tagged only `ghcr.io/${{ github.repository_owner }}/opengym-{api,web,mcp}:${{ github.sha }}`;
    `provenance: true`, `sbom: true`; final step echoes each `steps.<id>.outputs.digest` and
    writes them to `$GITHUB_STEP_SUMMARY`. **No `:latest`.**

---

## 4. Build order (one commit each, tests green at every step)

0. `git checkout -b homelab`; `git remote add upstream https://github.com/DuarteSantos8/openGym.git`;
   commit `HOMELAB-FORK.md`, this plan, `@HOMELAB-FORK.md` line in `CLAUDE.md`.
1. **api: food storage** — `food-store.js` in the profile state file, revision/cache handling,
   `readBody` max param. Tests: food routes exercise the actual state file and restart persistence.
2. **api: food routes** — `food.js`, dispatcher `{id}` regex, `foodRoutes` hook, admin-delete hook,
   openapi + regenerated docs. Tests: `test/food.test.js`, `test/food-concurrency.test.js`.
3. **api: service auth** — `service-auth.js`, dispatcher + `sessionOf` hooks, `notePull` skip,
   boot check. Tests: `test/service-auth.test.js`.
4. **api: MCP link codes + connected-apps proxy** — `mcp-link.js`, routes, `/api/config` flag.
   Tests: `test/mcp-link.test.js` (with a stub mcp internal server).
5. **frontend: food** — `lib/food.js` + test, `views/Food.jsx`, route, Home/Settings entry, locales.
6. **frontend: MCP connect UI** — `components/McpConnect.jsx`, Settings wiring, locales.
7. **mcp: deps + API data path** — pin SDK 1.32.1 / express / zod, `config.js`, `api-client.js`,
   `request-context.js`, `state.js` ALS hook, `food-tools.js`, `mcp-server.js` (annotations, scopes).
   Existing `tools.test.js` must still pass unchanged.
8. **mcp: OAuth AS** — `oauth/store.js`, `clients-store.js`, `provider.js`, `consent.js`, `log.js`.
9. **mcp: HTTP entrypoint** — `http.js` (public + internal apps, origin/host checks, limits).
10. **containers** — Dockerfile stages, `mcp/Dockerfile`, `docker-compose.homelab.yml`,
    `Caddyfile.public`, `Caddyfile.private`, `.env.homelab.example`, `secrets/.gitignore`.
    Verify `docker compose -f docker-compose.homelab.yml up` with synthetic data.
11. **CI** — `.github/workflows/homelab.yml`.
12. **docs + summary** — homelab section in `mcp/README.md`; final summary for the Blue Hat review
    (files changed, SDK choice, native profile-state storage, registration modes, trade-offs).

---

## 5. Acceptance-test map

| Brief item | Test file → cases |
|---|---|
| 1 Food API | `api/test/food.test.js`: CRUD happy path; unknown field (create & patch) → 400; each bound (name 0/121, quantity 0/10001, bad unit/meal/date `2026-02-30`/time `24:00`, notes 501, negative kcal) → 400; stale `version` → 409; idempotent replay → same id, count 1; key reuse w/ different payload → 409; profile B GET/PATCH/DELETE A's id → 404; list `limit` > 200 → 400; body > 16 KiB → 413 |
| 2 Service auth | `api/test/service-auth.test.js`: no/wrong secret → 401; secret OK + `PUT /api/data`, `POST /api/logout`, `POST /api/push/subscribe`, `GET /api/admin/users` → 403; mixed cookie+service → 400; unknown/disabled profile → 401; `GET /api/data` + food CRUD → 200 and `source:'mcp'`; `/api/internal/*` without service → 404; feature-off (no file) → 401 |
| 3 OAuth + MCP | `mcp/test/oauth.test.js` (in-process express app, stub API): PRM (root + `/mcp` suffix) and AS metadata JSON; unauth `/mcp` → 401 + `WWW-Authenticate … resource_metadata=`; missing PKCE, `plain`, wrong verifier, redirect mismatch, missing `resource` → rejected; link code expired/used/wrong → rejected, 6th failure → 429; wrong-audience / expired / revoked token → 401; refresh reuse → family revoked (new access token also 401); token without `food:write` → write tool `INSUFFICIENT_SCOPE` and not listed; DCR: http redirect rejected, allowlist enforced, client cap; confidential client wrong secret → 401; consent POST without cookie/csrf → 403; profile A token can't read B (stub API asserts `X-OpenGym-Profile`) |
| 4 MCP tools | `mcp/test/e2e.test.js`: spawn real `api/server.js` (temp DATA_DIR + token file) + mcp app; full OAuth dance with SDK `Client` + `StreamableHTTPClientTransport`; call every tool; assert `tools/list` write tools ⊆ {create,update,delete}_food_log and annotations correct |
| 5 Concurrency | `api/test/food-concurrency.test.js`: 50 parallel PATCHes with same `version` → exactly 1 × 200, 49 × 409, final `version` = 2; 50 parallel creates with same idempotency key → 1 row. Plus all existing suites (`frontend`, `api`, `mcp`) green |

---

## 6. Security trade-offs to report

- CIMD not implemented (SDK lacks it) — DCR only; open DCR is rate-limited, capped, https-only.
- Behind Tailscale Funnel the client IP may be the funnel node; per-IP limits then degrade to a
  global limit — per-client and per-token limits still apply.
- One shared service secret for both directions (D8).
- Refresh `resource` leniency (D4) unless `MCP_STRICT_RESOURCE=1`.
- `api` keeps internet egress for Web Push (D6).
