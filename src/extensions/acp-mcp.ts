/**
 * Registers the MCP servers an ACP client sent (`session/new|load|resume` `mcpServers`) with Pi's
 * built-in MCP support. The adapter translates them into a session-scoped temp file and passes its
 * path in `PI_ACP_MCP_CONFIG` (see src/acp/mcp-config.ts and src/pi-rpc/process.ts).
 *
 * `pi.registerMcpServer()` registrations live only as long as this Pi process and are never written
 * to `mcp.json`. A server with the same name in the user's `mcp.json` takes precedence, so a client
 * cannot override the user's own (possibly authenticated) entry.
 */
import { readFileSync } from 'node:fs'

export const MCP_CONFIG_ENV = 'PI_ACP_MCP_CONFIG'

// Pi supplies the API at load time; this package does not depend on its packages.
interface ExtensionApi {
  registerMcpServer?(name: string, config: Record<string, unknown>): void
}

/** Read `{ mcpServers: { name: entry } }` from `path`. Missing or invalid file → no servers. */
export function readMcpServers(path: string): Array<[string, Record<string, unknown>]> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
    return Object.entries(servers as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])
    )
  } catch {
    return []
  }
}

export default function (pi: ExtensionApi, env: NodeJS.ProcessEnv = process.env): void {
  const path = env[MCP_CONFIG_ENV]
  if (!path) return

  const servers = readMcpServers(path)
  if (servers.length === 0) return

  if (typeof pi.registerMcpServer !== 'function') {
    console.error('[acp-mcp] this pi has no built-in MCP support (pi >= 0.99 required); ACP MCP servers ignored')
    return
  }

  for (const [name, config] of servers) {
    try {
      pi.registerMcpServer(name, config)
    } catch (err) {
      // Invalid names/configs, or a name another extension already registered, throw. Skip that
      // server and keep the rest.
      console.error(`[acp-mcp] could not register MCP server "${name}":`, err instanceof Error ? err.message : err)
    }
  }
}
