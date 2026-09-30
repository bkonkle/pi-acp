Fork of georgeharker/pi-acp. Local patches:

## Native status plus expandable subagent details (stock Zed)

The header-only approach below matched Zed's native status styling but could not expand without
an internal child thread. The single standard card at `32fba6c` expanded live output but showed a
hammer, not a spinner. Each child now has two adjacent rows: a `spawn_agent` status header with
Zed's spinner/checkmark/error visuals, followed by an expandable standard Details card. Both keep
stable identities and update together through completion, failure, interruption, and resume.
The details card retains task instructions as Markdown input, recent child tools and output
snippets, the latest response, a readable final result, and short log links. No Zed patch or
fictitious child session is needed. Zed's standard input/output labels remain; native
maximize/navigation is not available.

The bridge subscribes to the public child SDK session and hydrates missed message history.
Activity is bounded to eight tools, with 320-character/four-line output snippets; task prompts and
final responses have separate limits. Parent history inherited before the child's first prompt
is not shown as child activity. Resume clears old activity/errors and replaces the subscription.
Successful `Agent` invocation rows are suppressed in live events and history replay. Startup errors
still render normally; a background launch acknowledgement cannot complete its execution card,
and parent cancellation cannot emit updates for a launch row that was never created.

Regression tests cover streaming/hydration, ownership, cancellation, resume, startup failures,
large results, replay deduplication, and retained full model results. The RPC smoke checks real
paired status/detail bridge packets containing live command/output activity, compact log links,
and a silent abort. Tests also check header-before-details ordering and reuse of both rows.

Review regressions: response resets cross RPC as an explicit empty string, so a text-free failed
reply cannot keep an earlier response visible. The npm artifact includes the source helpers
required by its advertised extension entry points. Tests import those entry points from an actual
packed tarball; `smoke:package` additionally loads them using the real Pi resource loader.

## Historical native-header-only approach (superseded by paired rows)

The previous synthetic cards embedded up to 32,000 characters of transcript on every update.
They were noisy and still truncated. Commit `7410970` used `_meta.tool_name: "spawn_agent"`,
which Zed 1.21.0 recognizes in `ToolCall::is_subagent()` and routes to `render_subagent_card()`.
Zed supplies its own spinner/checkmark/error visuals; the adapter keeps the existing execution
lifecycle, interruption detection, and active-branch restoration.

Zed does not render an external child's preview without a registered child thread. No fake
`subagent_session_info` is sent. A compact read-kind companion row provides output/session file
links and a primary Go to File location, without copying the transcript into the parent thread.
Unchanged artifact links are not repeatedly emitted on observer heartbeats. Errors remain
readable even without a transcript file.

`Agent` and `get_subagent_result` display previews are bounded in live updates and history replay;
full prompt/result data stays in Pi, but isn't duplicated into ACP `rawInput`/`rawOutput`.
Tests cover native metadata, lifecycle order, artifacts, oversized results, and replay. The real
RPC smoke verifies native status rows, a full transcript larger than the old limit, and silent abort.

Source contract: https://github.com/zed-industries/zed/blob/v1.21.0/crates/acp_thread/src/acp_thread.rs#L1261-L1264

## 2026-09-23: no double server prefix in tool-call titles

Problem: MCP tool calls showed doubled server prefixes in Zed —
`notion_notion_notion-fetch`, `agent_memory_agent-memory_remember`. The model
often addresses the `mcp__<server>` namespace proxy with an already server-prefixed
inner tool name (`notion_notion-fetch`, `agent-memory_remember`, or the dotted
`server.tool` form — pi-mcp-adapter's `executeCall` resolves all of these), and
`toolCallTitle` unconditionally prepended the server name again.

Fix: `src/acp/tool-title.ts` strips a leading `<server>.` / `<server>_` prefix
(sanitized and raw-dash server forms) from the inner tool name before composing
the title, so the prefix appears exactly once: `notion_notion-fetch`,
`agent_memory_remember`. Bare inner names are untouched — dashes are not treated
as prefix separators, since many upstream tools genuinely start with
`<server>-` (e.g. notion's `notion-fetch`).

Tests: new cases in `test/unit/tool-title.test.ts` cover the prefixed, dotted,
sanitized, and bare inner-name forms.

## 2026-09-21: remove startup-info MOTD entirely

Problem: Zed sometimes ephemerally spins up a background agent thread "in case it needs it", then
drops it. Our startup-info prelude (pi version, Context/Skills/Extensions lists, update notice,
MCP wiring notice) was emitted as `agent_message_chunk` `session/update` notifications on
`session/new` — including for those throwaway threads — which interfered with them.

Fix: delete the whole prelude system rather than gating it. `session/new` no longer produces any
agent-visible startup message:

- `src/acp/agent.ts`: removed `buildStartupInfo`, `buildUpdateNotice`, `isSemver`/`compareSemver`,
  the `quietStartup` branch, `buildMcpNotice` usage, the `sendStartupInfoIfPending` timer, and
  `_meta.piAcp.startupInfo` from all three response sites.
- `src/acp/session.ts`: removed `startupInfo`/`startupInfoSent` state, `setStartupInfo()`,
  `sendStartupInfoIfPending()`.
- `src/acp/pi-settings.ts`: removed `getQuietStartup` (the setting existed only to gate the MOTD).
- `src/acp/mcp-config.ts`: removed `buildMcpNotice` and `piMcpAdapterInstalled` (notice-only).
  The generated MCP config file itself is unchanged — servers still get wired to pi; we just no
  longer chat about it. Skipped/preserved servers are visible in the generated config file.
- Tests: deleted `test/unit/startup-info-*.test.ts`, dropped the MCP-notice tests from
  `mcp-config.test.ts` and the re-emit test from `session-events.test.ts`.

Local setting note: `quietStartup` in pi settings.json is no longer read by the adapter; pi's TUI
still honors it for its own header. No pi-acp.json / settings.json changes are required.

## 2026-09-16: generic thread-title sync; auto-title extension moved to pi-setup

The bundled `auto-title` extension is gone. Titling was the only ACP-specific producer left, and
pi already streams everything needed to sync names generically:

- pi emits `session_info_changed` (AgentSession event) over RPC for ANY session-name change —
  extension `setSessionName()`, the `/name` command, RPC `set_session_name` (forwarded by
  `session.subscribe`; only `message_update` is rewritten by `toJsonEvent`). Verified in the
  installed pi's `dist/core/agent-session.js` + `dist/modes/rpc/rpc-mode.js`.
- pi persists the name itself (`sessionManager.appendSessionInfo`), so `get_state().sessionName`
  restores it on any resume — no custom entry needed for durability.

Adapter changes:

- `src/acp/session.ts`: new `session_info_changed` case → ACP `session_info_update` (title +
  `updatedAt`); new `emitTitleUpdate()` / `syncTitleFromState()` helpers. Removed the
  `acp:session_title` custom-entry decode branch and `src/acp/session-title.ts`.
- `src/acp/agent.ts`: `createSession` reuses its pre-fetched state to seed the title;
  `restoreSession` (the funnel for `session/load`, `session/resume`, lazy restores) seeds it
  fire-and-forget. Both calls are optional-chained since tests stub session objects.
- Removed `auto-title` from `BUNDLED_EXTENSIONS`, `package.json` `pi.extensions`, and the tsup
  entry list.
- Tests: `test/component/session-title.test.ts` covers the event sync (name change → title
  update, refresh per change, empty/undefined ignored, foreign custom entries ignored);
  `test/unit/session-title.test.ts` (entry parser) deleted; `bundled-extensions.test.ts` updated.

The extension now lives in [bkonkle/pi-setup](https://github.com/bkonkle/pi-setup) at
`home/.pi/agent/extensions/auto-title.ts` as a plain pi extension: `pi.setSessionName()` only,
plus a private `auto-title:name` marker entry for its manual-rename lock across resume. The old
extension documented a manual lock but never enforced it (generateTitle had no check); the new
one actually gates generation on it.

## 2026-09-16: derived tool-call titles for MCP gateway/proxy calls

Problem: Zed renders the ACP `tool_call` title verbatim. Pi surfaces MCP tools
through the pi-mcp-adapter gateway/proxy tools (`mcp`, `mcpScript`,
`mcp__<server>`), so Zed showed uninformative rows ("mcp", "mcpScript") where
OpenCode (which registers MCP tools individually) shows
`slack_slack_search_public` etc.

Fix: `src/acp/tool-title.ts` derives a title from the call args — `mcp` with
`args.tool` → the tool name; namespace proxies `mcp__<server>` →
`<server>_<tool>`; gateway meta-actions (search/describe/connect/...) and
`mcpScript` (first meaningful statement, skipping the `export const meta`
block) get short readable hints. Used at the `tool_call` / `tool_call_update`
emission sites in `src/acp/session.ts`; `tool_call_update` includes the title
only when it changed (streaming args often reveal `args.tool` after the call
first surfaces). Test: `test/unit/tool-title.test.ts`.

Root alternative without any adapter change: enable `directTools` per server
in the MCP config (`~/.config/mcp/mcp.json`), which registers each MCP tool
individually with its prefixed name — same labels OpenCode shows, at the cost
of the context tokens the proxy design exists to save. Direct tools do not
cover `mcpScript`, so the derived title still helps there.

## Advertise `max` thinking level

Local patch: advertise the `max` thinking level to ACP clients (Zed).

- src/acp/session.ts: add "max" to ThinkingLevel, isThinkingLevel, available modes
- src/pi-rpc/process.ts: accept "max" in set_thinking_level
- test: expect the extra option

pi clamps max down per-model via its own thinkingLevelMap, so this is safe for
models that do not support it. Upstream whitelist stops at xhigh.

## 2026-09-03: GLM 5.3 Flash max-effort troubleshooting

Finding: with the openai-completions override + thinkingLevelMap (max: "max"),
pi + adapter deliver thinkingLevel=max end-to-end (verified in pi session file
via ACP round trip). The Vercel gateway honors reasoning_effort=max and its
SSE streams complete cleanly under direct load tests (277KB, proper [DONE]).

Intermittent issue remains: roughly 1 in 5-8 pi turns on the openai-completions
route ends prematurely (mid-sentence, no error, stopReason=stop). Matches
upstream pi issue #4345 (premature stream close accepted as complete turn).
Anthropic-messages route did not show this in the same session sample, but is
capped at high's thinking budget (gateway ignores adaptive effort there).

models.json is currently set to the openai-completions override (max works,
occasional truncated turn) — tradeoff is live.

## Provenance

Based on georgeharker/pi-acp v0.3.1 (MIT), which forks svkozak/pi-acp (MIT).
Original work by Mario Zechner / pi-mono contributors via the coding-agent repo.
Our changes (see commits above) are in the same license.

## 2026-09-05: deep Zed integration pass

On top of georgeharker v0.3.1, this branch adds:

- SDK bump @agentclientprotocol/sdk 0.26.0 -> 1.4.0 (stable v1 wire unchanged; 1.x is the line
  that also carries the experimental v2 entry).
- `usage_update` at turn end (from pi `get_session_stats` contextUsage + cost) and the UNSTABLE
  `usage` block on `session/prompt` responses (Zed renders token/cost meters from these).
- Stable `messageId` grouping on agent_message_chunk/agent_thought_chunk, reset on pi
  `message_start` and at turn start.
- pi extension `input`/`editor` dialogs bridge to ACP form `elicitation/create` when the client
  advertises `elicitation.form` (Zed 1.12+); accept -> ui value, decline/cancel -> cancelled.
  Older clients keep the cancel-with-note fallback.
- Debug-gated stderr log for unknown pi RPC event types (`debug` key in pi-acp.json).

Verified: `session/unload` does not exist in ACP v1 (SDK 1.4.0 AGENT_METHODS) — not a gap;
`session/close` covers it.

## 2026-09-05: experimental ACP v2 draft agent (behind `enableV2`)

Track B from docs/v2-parity-and-mcp-plan.md, prototype stage against
`@agentclientprotocol/sdk/experimental/v2` (1.4.0). Off by default; turn on with
`"enableV2": true` in pi-acp.json. When enabled, `src/index.ts` serves both versions through the
SDK's `agentProtocolRouter()` — v1 clients are unaffected.

Design (src/acp/v2/agent.ts): delegate to the v1 PiAcpAgent (sessions, pi-RPC translation,
config options, titles) and adapt only the v2 wire differences:

- initialize: protocolVersion 2, v2 info/capabilities shape; v2 `capabilities` mapped back to the
  v1 `clientCapabilities`. Note: the v2 draft's ClientCapabilities only has
  auth/elicitation/nes/positionEncodings/\_meta — `terminal`/`fs` client caps don't exist there.
- session/prompt: accepted immediately; the turn runs in the background and completes via
  `state_update` running -> idle (stopReason + UNSTABLE usage). The SDK sends the prompt response
  when the handler resolves, so the turn must NOT be awaited in the handler.
- session/resume: `replayFrom:{type:"start"}` routes to the v1 history-replay load path; plain
  resume routes to v1 resume.
- session/set_config_option: typed values (`id`/`boolean`) pass through; response/replies
  translated.
- Update translation in the conn shim: chunk updates get a messageId if missing (v2 requires
  it), `plan` -> `plan_update` (items shape, entries preserved), `current_mode_update` dropped
  (v2 removed modes), config options `id` -> `configId` everywhere.

Not yet on the v2 path (deferred): unified message IDs per the full B6 semantics, structured
diffs (B6), elicitation create/complete round-trip re-verification under v2 zod (params are
passed through; v2 request shapes differ slightly, e.g. required `title` on request_permission).

Live harness: `node scripts/v2-smoke.mjs` (from the repo root, after `npm run build`) drives a
full v2 turn over stdio — initialize(2) -> session/new -> prompt -> state_update running -> idle —
and exits 0 on success.

Known wire caveat: v2 config options advertise `currentValue` from pi state at session start;
`providers/*`, `auth/login`, `nes/*`, document sync, and forking are unimplemented (v1 agent
ignores them too).
