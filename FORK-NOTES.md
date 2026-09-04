
Fork of georgeharker/pi-acp. Local patch: advertise the `max` thinking level to ACP clients (Zed).

- src/acp/agent.ts: add "max" to ThinkingLevel, isThinkingLevel, available modes
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
- Boolean config option `auto_compaction` (category model_config), advertised only when the
  client sends `session.configOptions.boolean`; wired to pi's `set_auto_compaction`.
- Debug-gated stderr log for unknown pi RPC event types (`PI_ACP_DEBUG`).

Verified: `session/unload` does not exist in ACP v1 (SDK 1.4.0 AGENT_METHODS) — not a gap;
`session/close` covers it.
