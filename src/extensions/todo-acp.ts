/**
 * todo-acp — bundled pi extension: file-based TODO.md → ACP plan bridge for pi.
 *
 * Convention: the agent (and you) track work in `TODO.md` at the project root
 * using GitHub-style checkboxes:
 *
 *   - [ ] pending task
 *   - [-] or [/] or [~]  in-progress task
 *   - [x] done task
 *
 * When TODO.md is written or edited, this extension parses the checkboxes and
 * appends an `acp:plan` custom session entry. The pi-acp adapter decodes those
 * entries into ACP `plan` session updates, which Zed renders as its native todo
 * checklist (the same display OpenCode/Codex get).
 *
 * Entries are appended ONLY when pi is driven headless over RPC (ctx.mode ===
 * 'rpc', i.e. by an ACP adapter) or when PI_ACP=1 is set, so interactive
 * terminal sessions stay untouched. Upstream pi-acp ignores unknown custom
 * entries, so this is harmless with any adapter.
 *
 * Custom entries persist in the session file but do not enter model context.
 *
 * Loaded by the adapter via `-e` (see src/pi-rpc/process.ts) and/or the package
 * `pi.extensions` key — the Symbol.for guard makes double loading a no-op.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const LOAD_GUARD = Symbol.for('pi-acp.extension.todo-acp')

// Minimal local API type: this package intentionally does not depend on pi's
// packages (pi injects the real API at load time; only the shapes below are needed).
interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: any) => void | Promise<void>): void
  appendEntry(customType: string, data?: unknown): string
}

interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done'
  kind?: string
}

interface PlanItem {
  id: string
  title: string
  status: string
  deps?: string[]
  kind?: string
}

const PLAN_ENTRY_TYPE = 'acp:plan'
const TODO_FILENAME = 'TODO.md'
const IGNORED_BASENAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

// ExtensionAPI handle, captured in the factory. Module-level helpers need it
// because they run outside the factory's scope.
let api: { appendEntry(customType: string, data?: unknown): string } | null = null

let active = process.env.PI_ACP === '1'
let cwd = ''
let seq = 0
let lastSig = ''
// toolCallId -> target path, captured at tool_execution_start
const pendingPaths = new Map<string, string>()

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'task'
  )
}

function mapStatus(marker: string): TodoItem['status'] | null {
  switch (marker.toLowerCase()) {
    case 'x':
    case '✔':
      return 'done'
    case '-':
    case '/':
    case '~':
    case '>':
      return 'in_progress'
    case ' ':
    case '':
      return 'pending'
    default:
      return null
  }
}

export function parseTodoMd(text: string): TodoItem[] {
  const items: TodoItem[] = []
  const seen = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  let section: string | undefined

  for (const raw of lines) {
    const heading = raw.match(/^#{1,6}\s+(.*)/)
    if (heading) {
      section = heading[1].trim()
      continue
    }

    const m = raw.match(/^\s*[-*+]?\s*\[([^\]]*)\]\s*(.*)$/)
    if (!m) continue

    const status = mapStatus(m[1])
    if (status === null) continue

    let title = m[2].trim()
    // Strip trailing markdown noise from task text
    title = title.replace(/\s+`[^`]*`$/, '').trim() || 'untitled'

    const base = slug(title)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const id = n === 0 ? base : `${base}-${n + 1}`

    const item: TodoItem = { id, title, status }
    // Section headers become a kind prefix, mirroring how the adapter
    // decorates entries from other namespaces.
    if (section && !/^todo/i.test(section)) item.kind = section.toLowerCase()
    items.push(item)
  }

  return items
}

function toPlanItems(items: TodoItem[]): PlanItem[] {
  return items.map(it => ({
    id: it.id,
    title: it.kind ? `(${it.kind}) ${it.title}` : it.title,
    status: it.status
  }))
}

function emit(items: TodoItem[]): void {
  if (!active) return
  const sig = JSON.stringify(items.map(i => [i.id, i.status, i.kind]))
  if (sig === lastSig) return
  lastSig = sig
  seq += 1
  try {
    api?.appendEntry(PLAN_ENTRY_TYPE, {
      op: 'snapshot',
      ns: 'todo',
      seq,
      items: toPlanItems(items)
    })
  } catch (err) {
    // Surface real bugs — silent failures here look like "todo panel broken"
    console.error(`[todo-acp] appendEntry failed:`, err)
  }
}

function parseAndEmit(): void {
  if (!cwd) return
  const file = join(cwd, TODO_FILENAME)
  if (!existsSync(file)) return
  try {
    emit(parseTodoMd(readFileSync(file, 'utf8')))
  } catch {
    // unreadable/partial write — skip until the next event
  }
}

function targetPath(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== 'object') return null
  const p = (args as { path?: unknown }).path
  if (typeof p === 'string') return p
  return null
}

function isTodoPath(p: string | null | undefined): boolean {
  if (!p) return false
  if (IGNORED_BASENAMES.has(basename(p))) return false
  // Match TODO.md (any case) anywhere: project root, nested plans/, etc.
  return /todo\.md$/i.test(p)
}

export default function (pi: ExtensionApi) {
  const g = globalThis as Record<symbol, unknown>
  if (g[LOAD_GUARD]) return
  g[LOAD_GUARD] = true

  api = pi

  pi.on('session_start', (_event: unknown, ctx: { cwd: string; mode?: string }) => {
    const mode = (ctx as unknown as { mode?: string } | null)?.mode
    active = mode === 'rpc' || process.env.PI_ACP === '1'
    cwd = ctx.cwd
    seq = 0
    lastSig = ''
    if (active) parseAndEmit()
  })

  pi.on('session_shutdown', () => {
    pendingPaths.clear()
  })

  type ToolEvent = { toolCallId: string; toolName?: string; args?: unknown; isError?: boolean }
  pi.on('tool_execution_start', (event: ToolEvent) => {
    const p = targetPath(event.args as Record<string, unknown>)
    if (p && isTodoPath(p)) pendingPaths.set(event.toolCallId, p)
  })

  pi.on('tool_execution_end', (event: ToolEvent) => {
    if (event.isError) return
    // File tools: react if this call touched TODO.md
    if (pendingPaths.delete(event.toolCallId)) {
      parseAndEmit()
      return
    }
    // Bash: react if the command referenced TODO.md (cheap heuristic —
    // reparsing is idempotent and signature-gated, so false positives are free)
    if (
      event.toolName === 'bash' &&
      typeof (event as unknown as { args?: { command?: unknown } }).args?.command === 'string' &&
      /todo\.md/i.test((event as unknown as { args: { command: string } }).args.command)
    ) {
      parseAndEmit()
    }
  })
}
