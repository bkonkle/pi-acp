/** Session-local external TODO.md → ACP plan snapshots. Repository TODO files are never consulted. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Pi supplies the API at load time; this package does not depend on its packages.
interface ExtensionContext {
  cwd: string
  mode?: string
  sessionManager?: { getSessionId(): unknown; getEntries?(): readonly unknown[] }
}

interface ExtensionEvent {
  reason?: string
  previousSessionFile?: string
  systemPrompt?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  isError?: boolean
}

interface ExtensionApi {
  on(event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown): void
  appendEntry(customType: string, data?: unknown): string
}

interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done'
  kind?: string
}

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
  let section: string | undefined

  for (const raw of text.split(/\r?\n/)) {
    const heading = raw.match(/^#{1,6}\s+(.*)/)
    if (heading) {
      section = heading[1].trim()
      continue
    }

    const m = raw.match(/^\s*[-*+]?\s*\[([^\]]*)\]\s*(.*)$/)
    if (!m) continue
    const status = mapStatus(m[1])
    if (status === null) continue

    const title =
      m[2]
        .trim()
        .replace(/\s+`[^`]*`$/, '')
        .trim() || 'untitled'
    const base = slug(title)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const item: TodoItem = { id: n === 0 ? base : `${base}-${n + 1}`, title, status }
    if (section && !/^todo/i.test(section)) item.kind = section.toLowerCase()
    items.push(item)
  }

  return items
}

function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)
}

function absolutePath(path: string, cwd: string): string {
  const p = path.startsWith('@') ? path.slice(1) : path
  return resolve(cwd, p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
}

function previousSessionId(file: string): string | null {
  try {
    const header: unknown = JSON.parse(readFileSync(file, 'utf8').split(/\r?\n/, 1)[0])
    if (
      header &&
      typeof header === 'object' &&
      'type' in header &&
      header.type === 'session' &&
      'id' in header &&
      validSessionId(header.id)
    ) {
      return header.id
    }
  } catch {
    // A missing or malformed parent session must not prevent starting a fork.
  }
  return null
}

export default function (pi: ExtensionApi) {
  let active = false
  let cwd = ''
  let planPath = ''
  let seq = 0
  let lastSig = ''
  const pendingPaths = new Map<string, string>()

  function emit(items: TodoItem[]): void {
    if (!active) return
    const sig = JSON.stringify(items)
    if (sig === lastSig) return
    try {
      pi.appendEntry('acp:plan', {
        op: 'snapshot',
        ns: 'todo',
        seq: seq + 1,
        items: items.map(it => ({
          id: it.id,
          title: it.kind ? `(${it.kind}) ${it.title}` : it.title,
          status: it.status
        }))
      })
      lastSig = sig
      seq += 1
    } catch (err) {
      console.error('[todo-acp] appendEntry failed:', err)
    }
  }

  function refresh(): void {
    if (!active || !planPath) return
    try {
      emit(parseTodoMd(readFileSync(planPath, 'utf8')))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') emit([])
      // Other read failures may be temporary; retain the snapshot until the next event.
    }
  }

  pi.on('session_start', (event, ctx) => {
    active = ctx.mode === 'rpc' || process.env.PI_ACP === '1'
    cwd = ctx.cwd
    planPath = ''
    seq = 0
    lastSig = ''
    pendingPaths.clear()
    if (!active) return

    // Reload/resume must advance past snapshots already seen by the adapter.
    try {
      for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
        if (!entry || typeof entry !== 'object') continue
        const record = entry as { type?: unknown; customType?: unknown; data?: unknown }
        if (record.type !== 'custom' || record.customType !== 'acp:plan') continue
        if (!record.data || typeof record.data !== 'object') continue
        const data = record.data as { ns?: unknown; seq?: unknown }
        if (data.ns === 'todo' && typeof data.seq === 'number' && Number.isSafeInteger(data.seq)) {
          seq = Math.max(seq, data.seq)
        }
      }
    } catch {
      // Older/minimal session managers may not expose entries.
    }

    let id: unknown
    try {
      id = ctx.sessionManager?.getSessionId()
    } catch {
      // Fail closed rather than sharing a plan with an unidentified session.
    }
    if (!validSessionId(id)) {
      emit([])
      return
    }

    const root = absolutePath(
      process.env.PI_TODO_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'plans'),
      cwd
    )
    planPath = join(root, id, 'TODO.md')
    try {
      mkdirSync(dirname(planPath), { recursive: true, mode: 0o700 })
      if (!existsSync(planPath)) {
        let seed = ''
        if (event.reason === 'fork' && event.previousSessionFile) {
          const previousId = previousSessionId(event.previousSessionFile)
          if (previousId && previousId !== id) {
            try {
              seed = readFileSync(join(root, previousId, 'TODO.md'), 'utf8')
            } catch {
              // No parent plan: start empty.
            }
          }
        }
        writeFileSync(planPath, seed, { flag: 'wx', mode: 0o600 })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error('[todo-acp] plan initialization failed:', err)
      }
    }
    refresh()
  })

  pi.on('before_agent_start', event => {
    if (!active || !planPath) return
    return {
      systemPrompt: `${event.systemPrompt ?? ''}\n\nAgent task tracking: use only ${JSON.stringify(planPath)}. Use GitHub checkboxes: - [ ] pending, - [-] in progress, - [x] done. This external file is the source of truth for agent tasks. Never automatically create, read, move, ignore, or delete repository TODO.md files for task tracking; leave human TODO.md files unaffected.`
    }
  })

  pi.on('session_shutdown', () => {
    pendingPaths.clear()
    active = false
    planPath = ''
  })

  pi.on('tool_execution_start', event => {
    if (!active || !planPath || !event.toolCallId) return
    pendingPaths.delete(event.toolCallId)
    if (!['read', 'write', 'edit'].includes(event.toolName ?? '')) return
    if (!event.args || typeof event.args !== 'object' || !('path' in event.args)) return
    const path = event.args.path
    if (typeof path === 'string' && absolutePath(path, cwd) === planPath) {
      pendingPaths.set(event.toolCallId, planPath)
    }
  })

  pi.on('tool_execution_end', event => {
    const target = event.toolCallId ? pendingPaths.get(event.toolCallId) : undefined
    if (event.toolCallId) pendingPaths.delete(event.toolCallId)
    // Shell commands can remove a parent directory or mutate the plan before failing.
    if (event.toolName === 'bash' || (!event.isError && target === planPath)) refresh()
  })
}
