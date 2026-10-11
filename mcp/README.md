# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory.

It is read-only, runs locally as a stdio process spawned by the LLM client, adds no new
container, and requires no extra authentication. The LLM never sees passkeys, VAPID keys, or
session secrets — it can only read the same `state-<uid>.json` files the openGym api already
writes.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan. Read-only today; long-lived token auth + write tools are
> planned but not shipped yet. See **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Homelab Tools

Remote HTTP mode uses OAuth and profile-scoped API calls, never direct data-volume access.
Local stdio remains read-only and exposes profile tools and the calculator below; food tools
require remote HTTP mode. Body writes require the separate opt-in `body:write` permission;
general profile, workout and routine writes remain forbidden by the API service allowlist.

| Tool | Scope | Purpose |
|---|---|---|
| `get_body_measurements` | `opengym:read` | Enabled/custom fields, cm/in history including Navy readings, waist/neck/hip/body-fat goals and progress |
| `calculate_navy_body_fat` | `opengym:read` | Male/female US Navy estimate in cm or inches, without saving; female inputs require hips |
| `set_body_goals` | `body:write` | Weight, waist, neck, hip and body-fat goals; omitted values retained, null clears |
| `log_body_weight` | `body:write` | Dated weigh-ins with optional server-calculated Navy body fat |
| `log_body_measurements` | `body:write` | Built-in/custom measurements; cm and percent, omitted readings retained |
| `set_body_measurement_options` | `body:write` | Enabled built-in fields and optional custom definitions without deleting history |
| `get_nutrition_goals` | `opengym:read` | Daily calories and macronutrient goals |
| `set_nutrition_goals` | `food:write` | Replace all four daily goals; null or omitted fields clear the corresponding goal |
| `list_food_logs`, `get_food_log`, `get_nutrition_summary` | `opengym:read` | Food history and daily/range totals with goals |
| `create_food_log`, `update_food_log`, `delete_food_log` | `food:write` | Profile-owned food logging; updates require a version |

Navy readings are estimates, not medical assessments. Male waist measurements are taken at
the navel. To enable remote body logging, request `opengym:read body:write` and explicitly
check the body-write box when connecting. Existing tokens do not gain the new permission.
Every body write requires the `revision` returned by `get_body_measurements`; a 409 requires
a fresh read before retrying. Body goal/log circumferences use centimetres regardless of
the profile display unit; weight uses `weight_unit`. Navy inputs accept their own cm/in unit.

## Tools

Nine read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** The filesystem is the boundary — same as `docker compose` running on the
  user's box. No passkey material, VAPID keys, or session secrets ever cross it.
- **No telemetry, no network.** Reads `./data/*.json` and exits when the LLM client
  disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio. Requires a long-lived token auth path minted from the
  admin dashboard (new `./data/tokens.json`) and a write-lock against the web UI's read-modify-
  write of `state-<uid>.json`. Tools: `log_workout`, `add_bodyweight`, `edit_routine`,
  `assign_weekday`, `override_day`.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
