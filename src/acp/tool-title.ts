/**
 * Human-readable titles for ACP tool calls.
 *
 * Pi's built-in MCP support names tools `mcp__<server>__<tool>` and runs
 * scripts through `codemode`; pi-mcp-adapter used gateway/proxy tools whose
 * bare names tell clients like Zed nothing ("mcp", "mcpScript",
 * "mcp__<server>"). Derive a clearer title from the tool name and arguments:
 * `server/tool` like Pi's own renderer, or the first statement of a script.
 */

/** Upper bound for a derived title; clients truncate long titles anyway. */
const MAX_TITLE_LENGTH = 80

function truncate(text: string, max = MAX_TITLE_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** First meaningful statement of a codemode/mcpScript code blob, for a short title. */
function scriptHint(code: string): string | undefined {
  let skippingMeta = false
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    // Workflow scripts almost always start with a boilerplate meta block;
    // skip the whole statement, not just its first line.
    // codemode's optional first line sets run options, not intent.
    if (line.startsWith('// @options:')) continue
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
 * Models sometimes address the namespace proxy with an already server-prefixed
 * tool name — "server.tool", "server_tool", or "raw-server_tool" (the adapter's
 * executeCall resolves all of these). Strip the redundant prefix so the title
 * doesn't double up ("notion_notion_notion-fetch"). Only `.` and `_` count as
 * prefix separators: many upstream tools genuinely start with "<server>-"
 * (e.g. notion's "notion-fetch"), and stripping that would mangle bare names.
 * The proxy name carries the sanitized server namespace (dashes → underscores),
 * so both that form and the raw dashed form are stripped.
 */
function stripServerPrefix(tool: string, server: string): string {
  const raw = server.replace(/_/g, '-')
  for (const name of [server, raw]) {
    for (const sep of ['.', '_']) {
      const prefix = `${name}${sep}`
      if (tool.startsWith(prefix) && tool.length > prefix.length) return tool.slice(prefix.length)
    }
  }
  return tool
}

/**
 * Build the ACP tool-call title for a pi tool invocation.
 * Falls back to the bare tool name when nothing better is derivable.
 */
export function toolCallTitle(toolName: string, args: any): string {
  if (toolName === 'Agent' && typeof args?.description === 'string' && args.description.trim()) {
    return truncate(`Launch: ${args.description}`)
  }
  if (toolName === 'get_subagent_result' && typeof args?.agent_id === 'string') {
    return truncate(`Result: ${args.agent_id}`)
  }
  // Built-in MCP tools ("mcp__<server>__<tool>"): show "server/tool", as Pi's renderer does.
  const builtin = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (builtin) return truncate(`${builtin[1]}/${builtin[2]}`)

  // Built-in codemode: show the first meaningful statement of the script.
  if (toolName === 'codemode') {
    const code = args && typeof args === 'object' && typeof args.code === 'string' ? args.code : ''
    const hint = code ? scriptHint(code) : undefined
    return truncate(hint ? `codemode: ${hint}` : 'codemode')
  }

  // pi-mcp-adapter namespace proxies ("mcp__<server>"): args.tool is the server-local tool name.
  if (toolName.startsWith('mcp__')) {
    const server = toolName.slice('mcp__'.length)
    const inner = args && typeof args === 'object' && typeof args.tool === 'string' ? args.tool : undefined
    if (inner) return truncate(`${server}_${stripServerPrefix(inner.replace(/\./g, '_'), server)}`)
    return truncate(toolName)
  }

  // pi-mcp-adapter gateway proxy ("mcp"): args.tool is the fully-qualified tool name;
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
