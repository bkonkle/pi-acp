import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { getPiAcpMcpPolicyPath } from './paths.js'

// Marker written into generated configs so we only ever overwrite / clean up files
// that pi-acp authored, never a hand-written `.pi/mcp.json`.
const GENERATED_MARKER = 'pi-acp'

type PiMcpStdioEntry = { command: string; args?: string[]; env?: Record<string, string> }
type PiMcpHttpEntry = { url: string; headers?: Record<string, string> }
type PiMcpEntry = PiMcpStdioEntry | PiMcpHttpEntry

export type PiMcpConfig = {
  mcpServers: Record<string, PiMcpEntry>
  _generatedBy?: string
}

export type McpTranslation = {
  config: PiMcpConfig
  /** Names of servers we could not express in pi's `mcpServers` schema (sse / acp). */
  skipped: string[]
  /** Names skipped because a policy said to defer to the user's own (lower-precedence) config. */
  preserved: string[]
}

/**
 * Policy consulted when generating `.pi/mcp.json`, loaded from
 * `<pi-acp dataDir>/mcp-policy.json` (default `~/.pi/pi-acp/mcp-policy.json`).
 *
 * Why: the ACP `McpServer` shape can't express bearer auth, so a client-sent server may arrive
 * without the credentials the user configured for it. Pi's own `mcp.json` entry with the same name
 * always wins over a registered one, but the operator can also stop pi-acp from registering a server
 * at all — **same semantics pi-subagents uses for tool/extension inheritance** (`true | string[] |
 * false` + an exclude denylist):
 *
 *  - `generate`: which servers pi-acp may write. `true`/`"*"`/omitted = all (default, current
 *    behavior), `string[]` = only those names, `false` = none. Servers NOT generated are
 *    **preserved** — pi-acp leaves the user's own (lower-precedence) `mcp.json` entry and its auth
 *    in place. (Names are case-insensitive.)
 *  - `exclude`: denylist applied after `generate` (exclude wins) — e.g. a globally-configured,
 *    bearer-auth'd server you never want pi-acp to override.
 *  - `auth`: for a server pi-acp DOES generate, write `Authorization: Bearer ${<VAR>}` (+ extra
 *    headers). Pi resolves `${VAR}` when it connects, so the token is never on disk.
 *
 * Shape: `{ "generate": true | "*" | ["a","b"] | false, "exclude": ["x"],
 *          "auth": { "<name>": { "bearerTokenEnv": "VAR", "headers": {…} } } }`
 */
export type McpServerAuth = { bearerTokenEnv?: string; headers?: Record<string, string> }
export type McpPolicy = {
  generate?: boolean | '*' | string[]
  exclude?: string[]
  auth?: Record<string, McpServerAuth>
}

type NameValue = { name: string; value: string }

/** Load the MCP generation policy. Missing/invalid file → `{}` (default: generate all). */
export function loadMcpPolicy(path: string = getPiAcpMcpPolicyPath()): McpPolicy {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const obj = raw as { generate?: unknown; exclude?: unknown; auth?: unknown }
    const out: McpPolicy = {}

    if (typeof obj.generate === 'boolean' || obj.generate === '*') out.generate = obj.generate
    else if (Array.isArray(obj.generate)) out.generate = obj.generate.filter((x): x is string => typeof x === 'string')

    if (Array.isArray(obj.exclude)) out.exclude = obj.exclude.filter((x): x is string => typeof x === 'string')

    if (obj.auth && typeof obj.auth === 'object') {
      const auth: Record<string, McpServerAuth> = {}
      for (const [name, val] of Object.entries(obj.auth as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') continue
        const v = val as { bearerTokenEnv?: unknown; headers?: unknown }
        const entry: McpServerAuth = {}
        if (typeof v.bearerTokenEnv === 'string' && v.bearerTokenEnv) entry.bearerTokenEnv = v.bearerTokenEnv
        if (v.headers && typeof v.headers === 'object') {
          const headers: Record<string, string> = {}
          for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) headers[k] = String(hv)
          if (Object.keys(headers).length) entry.headers = headers
        }
        auth[name] = entry
      }
      out.auth = auth
    }

    return out
  } catch {
    return {}
  }
}

/** Whether pi-acp may generate an entry for `name` (exclude wins over generate). Default: yes. */
function shouldGenerate(name: string, policy: McpPolicy): boolean {
  const lc = name.toLowerCase()
  if ((policy.exclude ?? []).some(n => n.toLowerCase() === lc)) return false
  const gen = policy.generate
  if (gen === false) return false
  if (gen === undefined || gen === true || gen === '*') return true
  return gen.some(n => n.toLowerCase() === lc)
}

/**
 * Pi accepts MCP server names made of letters, digits, `_`, and `-` and rejects the rest. ACP clients
 * may send display names ("Chrome DevTools"), so replace other characters with `-`.
 */
export function toPiServerName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function toRecord(pairs: readonly NameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    if (p && typeof p.name === 'string') out[p.name] = String(p.value ?? '')
  }
  return out
}

/**
 * Translate ACP `McpServer[]` into pi's `mcpServers` shape (the same shape `pi.registerMcpServer()`
 * accepts). stdio and http servers translate cleanly; sse / acp variants are not expressible and are
 * reported as `skipped`. Policy names match the client's name; the entry key is the pi-safe name.
 */
export function translateMcpServers(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = {}
): McpTranslation {
  const mcpServers: Record<string, PiMcpEntry> = {}
  const skipped: string[] = []
  const preserved: string[] = []

  for (const server of servers ?? []) {
    const name = String(server.name ?? '').trim()
    const key = toPiServerName(name)
    if (!name || !key) continue

    if (!shouldGenerate(name, policy)) {
      // Not in the generate allowlist (or excluded) — leave the user's existing mcp.json entry
      // (and its auth) in place rather than overriding it.
      preserved.push(name)
      continue
    }

    const rule = policy.auth?.[name]
    const type = (server as { type?: string }).type

    if (!type || type === 'stdio') {
      const stdio = server as { command?: string; args?: string[]; env?: NameValue[] }
      const command = String(stdio.command ?? '').trim()
      if (!command) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpStdioEntry = {
        command,
        args: Array.isArray(stdio.args) ? stdio.args.map(String) : []
      }
      const env = toRecord(stdio.env)
      if (Object.keys(env).length) entry.env = env
      mcpServers[key] = entry
    } else if (type === 'http') {
      const http = server as { url?: string; headers?: NameValue[] }
      const url = String(http.url ?? '').trim()
      if (!url) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpHttpEntry = { url }
      // Client-sent headers, then policy headers, then a policy bearer — policy wins. The bearer is
      // written as `${VAR}` so pi resolves it at connect and the token is never stored on disk.
      const headers: Record<string, string> = { ...toRecord(http.headers), ...(rule?.headers ?? {}) }
      if (rule?.bearerTokenEnv) headers['Authorization'] = `Bearer \${${rule.bearerTokenEnv}}`
      if (Object.keys(headers).length) entry.headers = headers
      mcpServers[key] = entry
    } else {
      // sse / acp: pi supports only stdio and streamable HTTP.
      skipped.push(name)
    }
  }

  return { config: { mcpServers, _generatedBy: GENERATED_MARKER }, skipped, preserved }
}

export type McpConfigHandle = {
  path: string
  /** Remove the generated file. No-op if the file was replaced by a non-generated one. */
  cleanup: () => void
}

export type WriteMcpConfigResult = {
  handle: McpConfigHandle | null
  skipped: string[]
  /** Server names not generated because the policy said to defer to the user's own config. */
  preserved: string[]
}

function isGeneratedConfig(path: string): boolean {
  try {
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as { _generatedBy?: unknown }
    return existing?._generatedBy === GENERATED_MARKER
  } catch {
    return false
  }
}

/**
 * Write the ACP-provided MCP servers to a **session-scoped temp file**. Its path is passed to the
 * spawned pi in `PI_ACP_MCP_CONFIG` (see PiRpcProcess.spawn), and the bundled `acp-mcp` extension
 * registers each entry with `pi.registerMcpServer()`. This deliberately does NOT write
 * `<cwd>/.pi/mcp.json`: that path is pi's own *project config namespace* (settings, prompts, trust,
 * mcp), so writing there persisted past the session and leaked into unrelated (even non-ACP) pi
 * sessions launched from the same cwd. Registered servers never override the user's `mcp.json`
 * entries. The temp file is removed on session end. Returns `handle: null` when there is nothing to
 * write.
 */
export function writeMcpConfig(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = loadMcpPolicy()
): WriteMcpConfigResult {
  const { config, skipped, preserved } = translateMcpServers(servers, policy)

  if (Object.keys(config.mcpServers).length === 0) {
    return { handle: null, skipped, preserved }
  }

  // The file may contain secrets the client sent literally (an Authorization header value, or stdio
  // `env` values like API keys). `mkdtempSync` gives a 0700 (owner-only) parent dir; write the file
  // 0600 too as defense-in-depth. The durable way to keep a bearer OFF disk is the policy's
  // `bearerTokenEnv`, which writes `Bearer ${VAR}` (resolved by pi at connect).
  let dir: string
  let path: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
    path = join(dir, 'mcp.json')
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch {
    return { handle: null, skipped, preserved }
  }

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort; the file lives in the OS temp dir
    }
  }

  return { handle: { path, cleanup }, skipped, preserved }
}

/**
 * Best-effort removal of a stale `<cwd>/.pi/mcp.json` that a PREVIOUS pi-acp version generated
 * (marked `_generatedBy: pi-acp`). Older builds wrote into pi's project config namespace; a leftover
 * one still wins at highest precedence and would re-introduce the override/persistence hazard. Only
 * ever removes a file pi-acp authored — never a hand-written config.
 */
export function cleanupStaleGeneratedConfig(cwd: string): void {
  const path = join(cwd, '.pi', 'mcp.json')
  try {
    if (existsSync(path) && isGeneratedConfig(path)) rmSync(path, { force: true })
  } catch {
    // best effort
  }
}
