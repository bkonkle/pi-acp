# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

Setting up a fresh machine? See [Setting up on a new machine](#setting-up-on-a-new-machine) — the
checklist is written so an agent can follow it end to end.

## Differences from upstream

This is a fork of [`georgeharker/pi-acp`](https://github.com/georgeharker/pi-acp) (`@geohar/pi-acp`), which itself is a fork of [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp).

On top of upstream it adds (including George Harker's changes):

- **Subagents as ACP tasks** — a bundled pi extension bridges the
  [pi-subagents](https://github.com/tintinweb/pi-subagents) fleet into the ACP `plan` channel, so
  each subagent shows up as a task. See [Subagents as tasks](#subagents-as-tasks).
- **Bundled pi extensions** — `todo-acp` ships in this package and is loaded into
  every spawned `pi` automatically (no user-level extension files needed). See
  [Bundled pi extensions](#bundled-pi-extensions).
- **ACP thread titles** — the `/name <title>` slash command sets the pi session name and pushes an
  ACP `session_info_update`, which Zed applies to the thread title. The adapter also forwards pi's
  `session_info_changed` event for every session-name change, so a general auto-titling extension
  (kept outside this repo — e.g. in pi-setup) titles threads without any ACP-specific code.
- **Thinking-level fixes** — thinking-level advertisement/filtering is matched to the active
  model's `thinkingLevelMap` (upstream advertises levels some models don't support).
- **Usage / cost metering** — emits ACP `usage_update` (context-window tokens + cumulative cost)
  at the end of each turn and attaches the UNSTABLE `usage` block to `session/prompt` responses,
  so clients like Zed can render token/cost meters.
- **Message-ID chunk grouping** — streamed `agent_message_chunk` / `agent_thought_chunk` updates
  carry a stable `messageId` per assistant message (reset on pi `message_start`).
- **Elicitation bridge** — pi extension `input`/`editor` dialogs are bridged to ACP form
  `elicitation/create` when the client advertises `elicitation.form` (Zed 1.12+); other clients
  keep the cancel-with-note fallback.
- **MCP auto-configuration** — ACP `mcpServers` are translated into a generated `<cwd>/.pi/mcp.json`
  for [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) to load. See
  [MCP servers](#mcp-servers).
- **Multi-root workspaces** — additional workspace roots on `session/new` / `session/load`
  (`sessionCapabilities.additionalDirectories`), communicated to pi via `--append-system-prompt`.
- **v2-oriented session capabilities** — advertises `session/resume`, `session/close`, and
  `mcpCapabilities.http` (steps toward ACP v2 parity; see `docs/v2-parity-and-mcp-plan.md`).
- **Experimental ACP v2 draft agent** — off by default; set `"enableV2": true` in pi-acp.json to
  serve the ACP v2 draft behind the SDK's dual-version router (v1 clients unaffected). The v2
  path delegates to the same session engine and translates the v2 wire differences (async prompt
  with `state_update` lifecycle, `replayFrom` resume, typed config-option values, `plan_update`,
  `configId` naming, required chunk `messageId`s). See `FORK-NOTES.md` for scope and caveats.
- **`PI_ACP_DATA_DIR`** — env override for the adapter's own data directory (see
  [Environment variables](#environment-variables)).

## Features

- Streams assistant output as ACP `agent_message_chunk` (grouped by stable `messageId` per message)
- Emits ACP `usage_update` after each turn (context-window tokens, cumulative cost) and a per-turn
  `usage` block on `session/prompt` responses, for clients that render token/cost meters
- Bridges pi extension `input`/`editor` UI dialogs to ACP form elicitations when the client
  supports them (`elicitation.form`)
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Multi-workspace support (`sessionCapabilities.additionalDirectories`)
  - ACP clients can pass additional workspace roots on `session/new` / `session/load` (e.g. Zed multi-root workspaces)
  - `cwd` stays the primary working directory; the additional roots are communicated to pi via `--append-system-prompt`, since pi has no native multi-root workspace concept
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) No startup “MOTD” is emitted into the session — the adapter sends nothing until the first real prompt (pi’s TUI header info is not mirrored into ACP sessions).
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version)

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@geohar/pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g @geohar/pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Settings (`pi-acp.json`)

pi-acp reads its own settings from `pi-acp.json` in the pi agent's `extensions/` directory — i.e. `<PI_CODING_AGENT_DIR>/extensions/pi-acp.json` (default `~/.pi/agent/extensions/pi-acp.json`), alongside other extensions' settings. This is a dedicated pi-acp file; it is **not** merged into pi's own `settings.json`. A default file is written on first run if one does not already exist, and an existing file is never overwritten. For backward compatibility the pre-0.2.2 location — `<PI_CODING_AGENT_DIR>/pi-acp.json` (agent root) — is still read as a fallback when no file exists in `extensions/`.

Options:

- `embeddedContext` (boolean, default `true`) — advertises ACP `promptCapabilities.embeddedContext` to the client. When `false`, compliant ACP clients should avoid sending embedded `resource` blocks; if they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.
- `rpcTimeoutMs` (number, default `120000`) — per-request timeout for pi RPC calls. Generous so legitimately slow commands (e.g. compaction) finish.
- `debug` (boolean, default `false`) — emit adapter debug logging to stderr.
- `piCommand` (string, optional) — override the pi executable name/path. Absent = platform default (`pi`, or `pi.cmd` on Windows).
- `dataDir` (string, optional) — override pi-acp's own data directory. Absent = `~/.pi/pi-acp`. This controls where the session-map file and any future adapter-owned data is stored; it is separate from `PI_CODING_AGENT_DIR`, which rehomes pi's own agent directory (and hence `extensions/pi-acp.json`).

The default file written on first run contains:

```json
{
  "embeddedContext": true,
  "rpcTimeoutMs": 120000,
  "debug": false
}
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

Extension commands can be invoked by typing their slash command, but are not advertised in the command picker. Commands and intercepted inputs that finish without starting a model run no longer leave the ACP prompt pending. TUI-only dialogs such as `/agents` still cannot render in Zed.

## Subagents as tasks

pi itself emits no ACP plans, so the ACP `plan` (task-list) channel is unused. When you use the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension, pi-acp can surface the running
subagent fleet as an ACP plan — each subagent becomes a task with `pending` / `in_progress` /
`completed` status. Each also gets **two adjacent rows**, usable in stock Zed:

- A native status row with Zed's spinner/checkmark/error icon, task, tool count, and elapsed time.
- An expandable **Details** card below it, available while the child is running. It shows task
  instructions, recent tool calls with commands/paths and short output previews, the latest
  response, and a Markdown **Subagent Output** section on completion.

Existing logs appear as short named links inside the details card; the primary file also has a
Go to File action. There is no separate successful launch or file-output row.

The bridge observes the child's SDK session directly: tool start/end events update the activity,
while message hydration fills in missed history without duplicating calls or reopening finished ones.
Cards show up to eight recent tools (320 characters / four lines of output per tool), a 2,000-character
task prompt, and up to 5,000 characters of final response. Raw JSONL transcript tails and result-detail
objects are never dumped into the card. Full results delivered to Pi are unchanged. Result-retrieval
and untracked invocation previews remain capped at eight lines / 800 characters, including replay.
Startup/validation errors with no child execution still get a visible invocation row.

Background `Agent` calls can return an id while their execution cards continue updating; cancellation
of the parent prompt alone does not finish a child. Reloaded history restores card activity/results
without replaying a redundant successful launch. If upstream transcripts are disabled, no new output
file is created; bounded card data remains in the existing ACP session-tracking entries.

The status row uses `spawn_agent` to select Zed's native status visuals. That header cannot expand
without a child conversation registered inside Zed, so the separate standard ACP details card
provides the working disclosure arrow and live Markdown output. Zed retains its standard
input/output labels. Native child-thread navigation/maximize is unavailable without changes to Zed,
and no fictitious child session is advertised.

Because pi's RPC mode does not forward pi's in-process event bus (`subagents:*`), the bridging is
done by a pi extension. The `pi-acp` package doubles as that extension (`src/pi-extension.ts`,
declared under `pi.extensions`): loaded inside pi, it subscribes to the bus and, for each change,
persists a **`CustomEntry`** via `pi.appendEntry("acp:subagents", <record>)`. Appending emits an
`entry_appended` event, which pi forwards over RPC (unlike the bus itself); the adapter decodes it
into a `plan` update. `CustomEntry` (not `CustomMessageEntry`) is used deliberately so the fleet
state is recorded without entering the model's context. `entry_appended` forwards while a turn is
active (subagents run inside turns), so plan updates track the fleet during a prompt.

No configuration — it just works once the two packages are installed:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@geohar/pi-acp   # loads the pi.extensions entry (the bridge)
```

The adapter marks the pi process it spawns with `PI_ACP=1`, which activates the bundled extension
there; the extension stays inert in a normal terminal `pi` session (no marker), so it has no effect
outside the adapter.

ACP `PlanEntryStatus` has no failed state, so the checklist annotates failed, aborted, stopped,
and interrupted tasks; their tool cards use ACP's `failed` status. The bridge reconciles known
top-level agents through pi-subagents' public registry every second, catching silent queued
cancellation and turn-limit completion. It persists changed previews at most every two seconds
and status observations every ten seconds; those observations are not proof of progress. Actual
child tool/text events and output-file changes carry activity timestamps separately.

Process death, session replacement, and shutdown close unfinished cards as interrupted. Resume
restores active-branch tracking records, bounded activity, final output, and log links, but never claims an old process's agents
are still running. Detached agents can continue after the parent prompt is cancelled; cancelling
the prompt alone does not claim to have stopped them. Extension listeners/timers are released on
shutdown and rebound on reload. The upstream lifecycle bus excludes workflow-owned and nested
agents, so these cards cover top-level agents, not the TUI's full workflow conversation viewer.

## Bundled pi extensions

This fork ships two pi extensions. They are built to `dist/extensions/*.js` and the adapter loads
them into every spawned `pi` process via `-e` (see `src/pi-rpc/process.ts`) — so installing this
package is the only setup step; no user-level extension files are needed. Each one is gated to
RPC/`PI_ACP=1` mode (inert in a normal terminal `pi`). Runtime state is activation-local, so a
reload registers fresh handlers rather than being blocked by a permanent process guard.

### `todo-acp` — external session plans as the Zed todo checklist

Track agent work in `~/.pi/agent/plans/<session-id>/TODO.md`, outside the workspace, using
GitHub-style checkboxes:

```markdown
- [ ] pending task
- [-] in-progress task
- [x] done task
```

The extension supplies the exact absolute plan path in the model's system prompt and mirrors
only that file into Zed's checklist. Reads/writes/edits to that path and completed shell commands
refresh the snapshot; an empty or deleted plan clears it. The external file remains the source
of truth. Repository `TODO.md` files are neither consulted nor moved, removed, or ignored.

`PI_CODING_AGENT_DIR` changes the default agent-directory root; `PI_TODO_DIR` explicitly overrides
the plans root. Every session keeps its own directory, including concurrent sessions in one
worktree. Resume reuses its plan; forks seed a separate copy from the parent's external plan.
New directories/files use `0700`/`0600` permissions. No per-session environment variable is set
in Pi's shared SDK process, so child sessions cannot inherit another session's plan path.

### Thread titles — generic `session_info_changed` sync

Thread titling is not bundled here. pi emits a `session_info_changed` RPC event for **any**
session-name change — an extension's `setSessionName()` (e.g. an auto-titling extension kept in
the user's pi-setup), the `/name` command below, or an RPC `set_session_name` — and the adapter
forwards each one to the client as an ACP `session_info_update`, which Zed applies to the thread
title. On session create/load/resume the adapter also seeds the title from pi's persisted
`get_state().sessionName`, so names survive restarts without relying on history replay.

The former bundled `auto-title` extension moved out of this repo for exactly this reason: with
`session_info_changed` synced generically, titling policy is a plain pi extension with zero ACP
coupling. A reference implementation lives in [bkonkle/pi-setup](https://github.com/bkonkle/pi-setup)
(`home/.pi/agent/extensions/auto-title.ts`): cheap-model titles in the form
`<PR number> | <issue number> | <2-5 lowercase words>` (segments omitted when unavailable),
generated in the background, refreshed every three completed runs by default, with a
manual-rename lock that survives resume.

Manual names win: `/name <title>` (the adapter's slash command) sets the name, pushes the
`session_info_update`, and locks auto-titling for that session (the lock survives resume). Renaming
from Zed's UI is a client-side override Zed never reports to the agent — the override always wins
for display, but the agent keeps titling the pi session underneath.

If you run the pi-setup extension, its model defaults to `zai/glm-5.3-flash` on the
`vercel-ai-gateway` provider; without a configured model, titling is silently skipped
(rate-limited warnings on pi's stderr).

### `pi-extension` — subagent fleet bridging

The [subagents-as-tasks](#subagents-as-tasks) bridge described above. Shipped as a package
extension (`pi.extensions`) since before the `-e` mechanism; also bundled for `dist/` installs so
subagent plans work from a source checkout without `pi install`.

## Setting up on a new machine

Checklist for reproducing the full setup (pi + this adapter + Zed + bundled extensions) on a fresh
machine. Written so an agent can execute it; only the auth steps need a human.

1. **Install pi and Node** — Node.js 22+, then `npm install -g @earendil-works/pi-coding-agent`.
   Verify with `pi --version`.
2. **Clone and build this package** —
   ```bash
   git clone git@github.com:bkonkle/pi-acp.git && cd pi-acp
   npm install && npm run build
   ```
   Building produces `dist/index.js` (the adapter) and `dist/extensions/*.js` (the bundled pi
   extensions, loaded automatically — no `pi install` and no user-level extension files needed).
3. **Point Zed at the adapter** — add to `~/.config/zed/settings.json`:
   ```json
   "agent_servers": {
     "pi-acp": {
       "type": "custom",
       "command": "node",
       "args": ["/absolute/path/to/pi-acp/dist/index.js"]
     }
   }
   ```
4. **Authenticate pi (human step)** — run `pi` in a terminal and log in to your providers
   (`/login` / `/model`). Auth material is per-machine; do not copy `~/.pi/agent/auth.json`.
5. **Optional: title model** — the auto-titling extension (kept in pi-setup, not bundled here)
   defaults to `zai/glm-5.3-flash` via a
   `vercel-ai-gateway` entry in `~/.pi/agent/models.json` (see [models](https://github.com/earendil-works/pi/blob/main/docs/models.md)).
   Without it, auto-titling is skipped but everything else works; `/name` still sets titles
   manually. If your models.json resolves the API key via a `!`-command, that script must exist on
   this machine too.
6. **Verify** — in this repo run `npm run smoke`. Expected on stdout: an `agent_message_chunk`
   reply and an `acp:plan` snapshot from the external session plan. With the
   pi-setup auto-title extension installed you'll also see a `session_info_update` with a
   `title`. Then open a pi-acp thread in Zed and check that the thread title changes from
   "New Agent Thread" after the first reply. `npm run smoke:tracking` exercises real Pi RPC with
   an offline execution fixture (no model call), checking external plans, immediate command
   completion, native status rows with live expandable details/log links, and silent cancellation.
   `npm run smoke:package` also packs the npm artifact and loads its advertised extensions through
   the real Pi resource loader (requires the Pi SDK installed locally or globally).

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
npm run smoke:tracking  # offline fixture through real Pi RPC
npm run smoke:package   # packed artifact through the real Pi SDK loader
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol, incl. bundled-extension loading)
- `src/extensions/*` – bundled pi extensions (`todo-acp`), loaded into spawned pi via `-e`
- `src/pi-extension.ts` – subagent-fleet→plan bridge (package extension, also bundled)
- `test/unit`, `test/component` – unit tests and fake-driven adapter tests

## Environment variables

| Variable      | Set by       | Purpose                                                                                                  |
| ------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `PI_ACP`      | adapter → pi | Marks the spawned pi process as ACP-driven; activates the bundled extensions outside RPC mode.           |
| `PI_TODO_DIR` | you          | Overrides the external session-plan root (default `<PI_CODING_AGENT_DIR>/plans` or `~/.pi/agent/plans`). |

The adapter's data directory is configured with `dataDir` in `extensions/pi-acp.json`, not an
environment variable.

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- No ACP permission gating (`session/request_permission`): pi executes tools locally and does not surface pre-execution tool intents over RPC, so the adapter cannot gate them yet.

## MCP servers

MCP servers passed by the ACP client (`session/new`, `session/load`, `session/resume`) are translated
into a **session-scoped temp file** and handed to [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
via `pi --mode rpc --mcp-config <tempfile>`. stdio and http servers are supported; sse/acp servers
cannot be expressed and are skipped with a notice. The temp file is removed when the session closes.
Install `pi-mcp-adapter` in your pi `packages` for the servers to actually load.

The temp file may hold secrets the client sent literally (an `Authorization` header value, or stdio
`env` values), so it is written in an owner-only (`0700`) temp dir with `0600` permissions. To keep a
bearer token off disk entirely, express it as `$env:VAR` (via the policy's `auth.bearerTokenEnv`, or a
`$env:`-valued header from the client) — pi-mcp-adapter resolves `$env:` at connect, so only the
placeholder is written.

pi-acp deliberately **does not** write `<cwd>/.pi/mcp.json`. That path is pi's own highest-precedence
project config namespace (settings, prompts, trust, mcp): writing there overrode the user's global
MCP config, persisted past the session, and leaked into unrelated (even non-ACP) pi sessions launched
from the same directory. `--mcp-config` overrides only pi-mcp-adapter's `pi-global` source, never pi's
config dir, so all of pi's own MCP config (global and project) still flows through. A stale
`<cwd>/.pi/mcp.json` left by an older pi-acp version (marked `_generatedBy: pi-acp`) is cleaned up
automatically.

### MCP generation policy

By default pi-acp generates every ACP-provided server into the temp overlay (additive — it never
overrides your own config). To control which servers it generates — same semantics pi uses for
subagent tool/extension inheritance — create `~/.pi/pi-acp/mcp-policy.json` (under `PI_ACP_DATA_DIR`):

```json
{
  "generate": "*",
  "exclude": ["mcp-combiner"],
  "auth": {
    "some-http-server": { "bearerTokenEnv": "MY_TOKEN", "headers": { "X-Extra": "v" } }
  }
}
```

- **`generate`** — which servers pi-acp may write: `true`/`"*"`/omitted = all (default) · `["a","b"]` =
  only those · `false` = none. Servers not generated are left to your own (lower-precedence) config.
- **`exclude`** — denylist (wins over `generate`): never generate these. Use it for a server you
  configure globally with its own auth (e.g. a bearer-auth'd combiner) so pi-acp doesn't override it.
- **`auth`** — for a server pi-acp _does_ generate, write `Authorization: Bearer $env:<VAR>` (+ extra
  headers). pi-mcp-adapter interpolates `$env:` at connect, so the token is never written to disk.

Names are case-insensitive. Note the ACP MCP shape has no dedicated auth field, so bearer auth can
only travel as an HTTP header — either provided by the client in the server's `headers`, or added via
this policy's `auth`.

- Additional workspace roots are not a hard filesystem boundary: pi can operate outside them. They are communicated to the model (workspace awareness), not enforced as a sandbox.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
