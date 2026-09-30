const SUBAGENT_TOOLS = new Set(['Agent', 'get_subagent_result'])

export function isSubagentInvocationTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name)
}

/** Display-only: Pi still receives the original prompt and tool results. */
export function subagentDisplayInput(name: string, input: unknown): unknown {
  if (!isSubagentInvocationTool(name) || input === null || typeof input !== 'object') return input
  const record = input as Record<string, unknown>
  return Object.fromEntries(
    ['description', 'subagent_type', 'agent_id', 'resume', 'run_in_background', 'wait', 'verbose']
      .filter(key => typeof record[key] === 'string' || typeof record[key] === 'boolean')
      .map(key => [key, typeof record[key] === 'string' ? record[key].slice(0, 160) : record[key]])
  )
}

export function compactSubagentText(text: string): string {
  const trimmed = text.trim()
  const preview = trimmed
    .split('\n')
    .slice(0, 8)
    .join('\n')
    .slice(0, 800)
    .replace(/[\uD800-\uDBFF]$/, '')
  return preview.length < trimmed.length
    ? `${preview}\n\nPreview only. Pi retains the full result; use the execution card’s full log link when transcripts are enabled.`
    : trimmed
}
