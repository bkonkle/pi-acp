
Fork of georgeharker/pi-acp. Local patch: advertise the `max` thinking level to ACP clients (Zed).

- src/acp/agent.ts: add "max" to ThinkingLevel, isThinkingLevel, available modes
- src/pi-rpc/process.ts: accept "max" in set_thinking_level
- test: expect the extra option

pi clamps max down per-model via its own thinkingLevelMap, so this is safe for
models that do not support it. Upstream whitelist stops at xhigh.
