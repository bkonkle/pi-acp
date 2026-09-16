/**
 * Human-readable titles for ACP tool calls.
 *
 * Pi surfaces MCP tools through gateway/proxy tools whose bare names tell
 * clients like Zed nothing ("mcp", "mcpScript", "mcp__<server>"). Derive a
 * clearer title from the call arguments, mirroring the per-tool naming used
 * when MCP tools are registered individually (e.g. "slack_slack_search_public").
 */

/** Upper bound for a derived title; clients truncate long titles anyway. */
const MAX_TITLE_LENGTH = 80

function truncate(text: string, max = MAX_TITLE_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** First meaningful statement of an mcpScript code blob, for a short title. */
function scriptHint(code: string): string | undefined {
  let skippingMeta = false
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    // Workflow scripts almost always start with a boilerplate meta block;
    // skip the whole statement, not just its first line.
    if (!skippingMeta && line.startsWith('export const meta')) {
      skippingMeta = !line.endsWith('}')
      continue
    }
    if (skippingMeta) {
      if (line === '}') skippingMeta = false
      continue
    }
    return line
  }
  return undefined
}

/** Short fragment for the mcp gateway's meta-actions (search/describe/connect/...). */
function gatewayAction(args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  if (typeof args.tool === 'string' && args.tool) return undefined // handled by caller
  if (typeof args.search === 'string' && args.search) return `search "${truncate(args.search, 60)}"`
  if (typeof args.describe === 'string' && args.describe) return `describe ${args.describe}`
  if (typeof args.connect === 'string' && args.connect) return `connect ${args.connect}`
  if (typeof args.instructions === 'string' && args.instructions) return `instructions ${args.instructions}`
  if (typeof args.action === 'string' && args.action) return args.action
  if (typeof args.server === 'string' && args.server) return `list ${args.server}`
  return undefined
}

/**
 * Build the ACP tool-call title for a pi tool invocation.
 * Falls back to the bare tool name when nothing better is derivable.
 */
export function toolCallTitle(toolName: string, args: any): string {
  // Namespace proxies ("mcp__<server>"): args.tool is the server-local tool name.
  if (toolName.startsWith('mcp__')) {
    const server = toolName.slice('mcp__'.length)
    const inner = args && typeof args === 'object' && typeof args.tool === 'string' ? args.tool : undefined
    if (inner) return truncate(`${server}_${inner.replace(/\./g, '_')}`)
    return truncate(toolName)
  }

  // Gateway proxy ("mcp"): args.tool is the fully-qualified tool name;
  // otherwise the call is one of the gateway's meta-actions.
  if (toolName === 'mcp') {
    if (args && typeof args === 'object' && typeof args.tool === 'string' && args.tool) {
      return truncate(args.tool.replace(/\./g, '_'))
    }
    const action = gatewayAction(args)
    return truncate(action ? `mcp ${action}` : 'mcp')
  }

  // Batched MCP scripting: show the first meaningful statement.
  if (toolName === 'mcpScript') {
    const code = args && typeof args === 'object' && typeof args.code === 'string' ? args.code : ''
    const hint = code ? scriptHint(code) : undefined
    return truncate(hint ? `mcpScript: ${hint}` : 'mcpScript')
  }

  return toolName
}
