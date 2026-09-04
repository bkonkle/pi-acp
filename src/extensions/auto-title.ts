/**
 * auto-title — bundled pi extension: generates a conversation title for the
 * session and pushes it to ACP clients (Zed's thread list) via the pi-acp
 * adapter.
 *
 * How it works:
 *   - The first title is generated at the first `turn_end` — right after the
 *     model's first response, seconds into the run — so even a long autonomous
 *     run gets titled immediately (it never waits for `agent_end`, and the
 *     generate call is async, never blocking the reply). It asks a cheap model
 *     (default GLM-5.3-flash via the Vercel AI gateway) for a title in the form
 *     `<PR number> | <issue number> | <lowercase title>`, omitting unavailable
 *     segments, built from the first user message and the latest exchange.
 *   - Refreshes every N completed runs (default 5) as the conversation evolves.
 *   - The title is set via `pi.setSessionName()` (so it also shows in pi's
 *     `/resume` picker) and appended as an `acp:session_title` custom entry.
 *     That entry crosses RPC as `entry_appended`; the pi-acp adapter decodes it
 *     and emits an ACP `session_info_update`, which Zed applies to the thread
 *     title.
 *
 * Manual names win: any name change that didn't come from this extension
 * (e.g. the adapter's `/name` command) locks auto-titling for the session, and
 * the lock persists across resume via a `{ source: 'manual' }` entry.
 *
 * Note: renaming the thread from Zed's UI is a client-side override — Zed never
 * tells the agent, so it can't lock here. Zed's override still wins for display.
 *
 * Active only when pi runs headless over RPC (ctx.mode === 'rpc', i.e. driven
 * by an ACP adapter) or when PI_ACP=1 is set, so interactive terminal sessions
 * are untouched. Config via env: PI_AUTO_TITLE_MODEL, PI_AUTO_TITLE_PROVIDER,
 * PI_AUTO_TITLE_EVERY.
 *
 * Loaded by the adapter via `-e` (see src/pi-rpc/process.ts) and/or the package
 * `pi.extensions` key — the Symbol.for guard makes double loading a no-op.
 */

// Minimal local types: this package intentionally does not depend on pi's packages
// (pi injects the real API at load time; only the shapes below are needed).
interface AssistantMessageLike {
  content: unknown
}
interface ModelLike {
  id?: string
}

const TITLE_ENTRY_TYPE = 'acp:session_title'
const DEFAULT_MODEL_ID = 'zai/glm-5.3-flash'
const DEFAULT_PROVIDER = 'vercel-ai-gateway'
const DEFAULT_EVERY = 5
const EXCERPT_CHARS = 600
const MAX_TITLE_CHARS = 80
const TITLE_TIMEOUT_MS = 30_000
const LOAD_GUARD = Symbol.for('pi-acp.extension.auto-title')

interface ExtensionApi {
  on(event: string, handler: (event: any, ctx: any) => void | Promise<void>): void
  appendEntry(customType: string, data?: unknown): string
  setSessionName(name: string): void
  getSessionName(): string | undefined
}

let api: ExtensionApi | null = null
let active = false
let busy = false
let turns = 0
let firstTitleDone = false
let lastTitle = ''
let lastManuallySet = ''
let warnCount = 0

function everyN(): number {
  const n = Number.parseInt(process.env.PI_AUTO_TITLE_EVERY ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EVERY
}

function warn(msg: string): void {
  // Rate-limit: a broken model config shouldn't spam stderr on every turn.
  if (warnCount++ < 3) process.stderr.write(`[auto-title] ${msg}\n`)
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  }
  return ''
}

function truncate(text: string, max = EXCERPT_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

interface Excerpt {
  firstUser: string
  latestUser: string
  latestAssistant: string
}

function collectExcerpt(ctx: any): Excerpt {
  const out: Excerpt = { firstUser: '', latestUser: '', latestAssistant: '' }
  try {
    const entries: any[] = ctx.sessionManager.getBranch()
    for (const e of entries) {
      if (e?.type !== 'message') continue
      const role = e.message?.role
      const text = truncate(textFromContent(e.message?.content))
      if (!text) continue

      if (role === 'user') {
        if (!out.firstUser) out.firstUser = text
        out.latestUser = text
      } else if (role === 'assistant') {
        out.latestAssistant = text
      }
    }
  } catch {
    // best effort — a shape change just means a weaker title prompt
  }
  return out
}

function findTitleModel(ctx: any): ModelLike | undefined {
  const provider = process.env.PI_AUTO_TITLE_PROVIDER || DEFAULT_PROVIDER
  const modelId = process.env.PI_AUTO_TITLE_MODEL || DEFAULT_MODEL_ID
  const registry = ctx.modelRegistry
  const exact = registry.find?.(provider, modelId)
  if (exact) return exact
  // Fall back to a catalogue scan (custom models.json entries can key differently).
  const all: ModelLike[] = registry.getAll?.() ?? []
  return all.find(m => m.id === modelId || m.id?.endsWith(`/${modelId}`))
}

function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  // Strip wrapping quotes and a single trailing period the model may add.
  t = t
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .replace(/\.$/, '')
    .trim()
  // Collapse separator spacing to a canonical ' | '.
  t = t.replace(/\s*\|\s*/g, ' | ')
  if (t.length > MAX_TITLE_CHARS) t = `${t.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
  return t
}

function textFromAssistant(msg: AssistantMessageLike): string {
  return textFromContent(msg.content)
}

async function generateTitle(ctx: any): Promise<void> {
  const { firstUser, latestUser, latestAssistant } = collectExcerpt(ctx)
  if (!firstUser && !latestUser) return

  const model = findTitleModel(ctx)
  if (!model) {
    warn(
      `title model not found (PI_AUTO_TITLE_MODEL=${process.env.PI_AUTO_TITLE_MODEL || DEFAULT_MODEL_ID}) — skipping`
    )
    return
  }

  const parts: string[] = []
  if (firstUser) parts.push(`First request:\n${firstUser}`)
  if (latestUser && latestUser !== firstUser) parts.push(`Latest request:\n${latestUser}`)
  if (latestAssistant) parts.push(`Latest reply (excerpt):\n${latestAssistant}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt:
          'You generate titles for coding-agent conversations.\n' +
          "Output format: `<PR number> | <issue number> | <lowercase title>`, separated by ' | '.\n" +
          '- PR number: include only if the conversation references a GitHub pull request ' +
          "(e.g. 'PR #123', 'pull/123', a PR URL). Output just the digits, no '#'.\n" +
          '- Issue number: include only if the conversation references a GitHub issue ' +
          "(e.g. 'fixes #45', 'issue #45', an /issues/ URL). Output just the digits, no '#'.\n" +
          '- Title: 2-5 lowercase words describing the conversation, concrete nouns preferred.\n' +
          '- Omit any segment that is not available (drop its separator too).\n' +
          'Examples:\n' +
          "  '142 | 87 | fix auth redirect loop'   (PR and issue referenced)\n" +
          "  '142 | add todo panel'                (PR only)\n" +
          "  'fix auth redirect loop'              (neither)\n" +
          'Reply with ONLY the title, no quotes, no explanation.',
        messages: [
          {
            role: 'user',
            content: `Generate the conversation title.\n\n${parts.join('\n\n')}`
          }
        ]
      },
      { signal: controller.signal }
    )

    const title = cleanTitle(textFromAssistant(response))
    if (!title || title === lastTitle) return

    lastTitle = title
    lastManuallySet = title
    try {
      api?.setSessionName(title)
      api?.appendEntry(TITLE_ENTRY_TYPE, { title, source: 'auto' })
    } catch (err) {
      warn(`failed to set session name: ${err}`)
    }
  } catch (err) {
    warn(`title generation failed: ${err}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Find the last `acp:session_title` entry to restore state after resume. */
function restoreState(ctx: any): void {
  try {
    const entries: any[] = ctx.sessionManager.getEntries() ?? []
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e?.type === 'custom' && e.customType === TITLE_ENTRY_TYPE) {
        const data = e.data as { title?: unknown; source?: unknown } | undefined
        if (typeof data?.title === 'string') lastTitle = data.title
        if (data?.source === 'manual') {
          // Manual lock: the user named this session deliberately.
          lastManuallySet = typeof data.title === 'string' ? data.title : ''
        } else {
          // Auto title present but no later manual lock — stay unlocked.
          return
        }
        break
      }
    }
  } catch {
    // best effort
  }
}

export default function (pi: ExtensionApi): void {
  const g = globalThis as Record<symbol, unknown>
  if (g[LOAD_GUARD]) return
  g[LOAD_GUARD] = true

  api = pi

  pi.on('session_start', (_event, ctx) => {
    const mode = (ctx as { mode?: string } | null)?.mode
    active = mode === 'rpc' || process.env.PI_ACP === '1'
    turns = 0
    busy = false
    firstTitleDone = false
    lastTitle = pi.getSessionName() ?? ''
    lastManuallySet = lastTitle
    if (active) restoreState(ctx)
  })

  pi.on('session_info_changed', event => {
    const name = typeof event?.name === 'string' ? event.name : ''
    if (!active) return
    // Our own setSessionName echoes here — only treat foreign names as manual.
    if (name && name === lastManuallySet) return
    // Manual rename (e.g. the adapter's /name command): lock auto-titling.
    if (name) {
      lastTitle = name
      lastManuallySet = name
    }
    try {
      api?.appendEntry(TITLE_ENTRY_TYPE, { title: name || undefined, source: 'manual' })
    } catch {
      // best effort
    }
  })

  pi.on('message_end', async (event, ctx) => {
    if (!active || busy || firstTitleDone) return
    // First title fires at the end of the first assistant message — the moment
    // the model's first response lands, before any tools execute — so even a
    // long autonomous run gets titled within seconds. The generate call is
    // async and never blocks the agent's reply. (turn_end is not enough: pi
    // runs tool executions inside the turn, so it can fire late.)
    const role = (event as { message?: { role?: string } } | null)?.message?.role
    if (role !== 'assistant') return
    firstTitleDone = true
    if (!lastTitle) {
      busy = true
      try {
        await generateTitle(ctx)
      } finally {
        busy = false
      }
    }
  })

  pi.on('agent_end', async (_event, ctx) => {
    if (!active || busy) return
    turns += 1
    if (turns % everyN() !== 0) return

    busy = true
    try {
      await generateTitle(ctx)
    } finally {
      busy = false
    }
  })
}
