
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
