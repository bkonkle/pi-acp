/** Persist the in-process subagent/plan bus for the external ACP RPC adapter. */
import { open } from 'node:fs/promises'

const CUSTOM_TYPE = 'acp:subagents'
const PLAN_CUSTOM_TYPE = 'acp:plan'
const LOAD_GUARD = Symbol.for('pi-acp.extension.subagent-plan.apis')
const OWNER = Symbol.for('pi-acp.extension.subagent-plan.owner')
const MANAGER = Symbol.for('pi-subagents:manager')
const PREVIEW_BYTES = 32 * 1024

type BusHandler = (data: unknown) => void
type HookHandler = (event: unknown, ctx: unknown) => void | Promise<void>
interface PiExtensionApi {
  on(event: string, handler: HookHandler): void
  events: { on(channel: string, handler: BusHandler): () => void }
  appendEntry(customType: string, data?: unknown): string
}
interface Context {
  mode?: string
  sessionManager?: { getSessionId(): string; getHeader?(): { parentSession?: string } | null }
}
type Agent = { id: string; status: string } & Record<string, string | number | undefined>
interface Tracked {
  agent: Agent
  dirty: boolean
  persistedAt?: number
  fingerprint?: string
  needsFinal: boolean
}
interface Binding {
  sessionId: string
  agents: Map<string, Tracked>
  unsubscribe: (() => void)[]
  timer?: ReturnType<typeof setInterval>
  busy: boolean
}
interface Registry {
  getRecord(id: string): unknown
}
const strings = [
  'type',
  'description',
  'status',
  'result',
  'error',
  'toolCallId',
  'outputFile',
  'sessionFile',
  'rootSessionId'
]
const numbers = ['startedAt', 'completedAt', 'durationMs', 'toolUses']
const isActive = (status: string) =>
  ['queued', 'running', 'created', 'started', 'steered', 'compacted'].includes(status)
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}
function bounded(text: string): string {
  const bytes = Buffer.from(text)
  let start = Math.max(0, bytes.length - PREVIEW_BYTES)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}
function fields(value: Record<string, unknown>): Partial<Agent> {
  const result: Partial<Agent> = {}
  for (const key of strings) {
    if (typeof value[key] === 'string')
      result[key] = ['result', 'error'].includes(key) ? bounded(value[key]) : value[key]
  }
  for (const key of numbers) if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key]
  return result
}

export default function (pi: PiExtensionApi): void {
  const globals = globalThis as Record<symbol, unknown>
  const loaded = (globals[LOAD_GUARD] ??= new WeakSet<object>()) as WeakSet<object>
  if (loaded.has(pi)) return
  loaded.add(pi)
  let binding: Binding | undefined

  const append = (state: Binding, type: string, data: unknown): boolean => {
    if (binding !== state) return false
    try {
      pi.appendEntry(type, data)
      return true
    } catch {
      return false
    }
  }
  const persist = (state: Binding, tracked: Tracked, immediate = false) => {
    const now = Date.now()
    const elapsed = tracked.persistedAt === undefined ? Infinity : now - tracked.persistedAt
    if (!immediate && !(tracked.dirty && elapsed >= 2000) && elapsed < 10000) return
    if (append(state, CUSTOM_TYPE, { ...tracked.agent })) {
      tracked.dirty = false
      tracked.persistedAt = now
    }
  }
  const getRecord = (id: string): Record<string, unknown> | undefined => {
    try {
      const registry = globals[MANAGER] as Registry | undefined
      return object(registry?.getRecord(id))
    } catch {
      return undefined
    }
  }
  const merge = (tracked: Tracked, patch: Partial<Agent>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && tracked.agent[key] !== value) {
        tracked.agent[key] = value
        tracked.dirty = true
      }
    }
    const { startedAt, completedAt } = tracked.agent
    if (typeof startedAt === 'number' && typeof completedAt === 'number' && patch.durationMs === undefined) {
      tracked.agent.durationMs = Math.max(0, completedAt - startedAt)
    }
  }
  const tail = async (state: Binding, tracked: Tracked) => {
    const path = tracked.agent.outputFile
    if (typeof path !== 'string') return
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(path, 'r')
      const stat = await file.stat()
      const fingerprint = `${path}:${stat.size}:${stat.mtimeMs}`
      if (tracked.fingerprint === fingerprint) return
      const length = Math.min(PREVIEW_BYTES, stat.size)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, stat.size - length))
      if (binding !== state) return
      tracked.fingerprint = fingerprint
      merge(tracked, { latestOutput: buffer.subarray(0, bytesRead).toString('utf8'), lastActivityAt: stat.mtimeMs })
    } catch {
      // Output can be disabled or not created yet. Observation is not output activity.
    } finally {
      await file?.close().catch(() => {})
    }
  }
  const stopTimer = (state: Binding) => {
    if (state.timer) clearInterval(state.timer)
    state.timer = undefined
  }
  const reconcile = async (state: Binding): Promise<void> => {
    if (binding !== state || state.busy) return
    state.busy = true
    try {
      for (const tracked of state.agents.values()) {
        if (binding !== state) return
        if (!isActive(tracked.agent.status) && !tracked.needsFinal) continue
        const record = getRecord(tracked.agent.id)
        if (!tracked.needsFinal) {
          if (!record || (record.rootSessionId !== undefined && record.rootSessionId !== state.sessionId)) {
            merge(tracked, {
              status: 'interrupted',
              error: 'Subagent registry record is unavailable or no longer belongs to this session.',
              completedAt: Date.now()
            })
          } else {
            merge(tracked, fields(record))
            tracked.agent.observedAt = Date.now()
          }
        }
        const finalRead = tracked.needsFinal || !isActive(tracked.agent.status)
        await tail(state, tracked)
        if (binding !== state) return
        // Completion arriving during a live read needs another stat/read after that event.
        if (tracked.needsFinal && !finalRead) continue
        const terminal = !isActive(tracked.agent.status)
        tracked.needsFinal = false
        persist(state, tracked, terminal)
      }
    } finally {
      state.busy = false
      if (binding === state) {
        if (![...state.agents.values()].some(t => isActive(t.agent.status) || t.needsFinal)) stopTimer(state)
        // A terminal event may arrive while an earlier file read is in flight.
        if ([...state.agents.values()].some(t => t.needsFinal)) void reconcile(state)
      }
    }
  }
  const ensureTimer = (state: Binding) => {
    if (!state.timer) {
      state.timer = setInterval(() => void reconcile(state), 1000)
      state.timer.unref?.()
    }
  }
  const shutdown = () => {
    const state = binding
    if (!state) return
    for (const tracked of state.agents.values()) {
      if (isActive(tracked.agent.status)) {
        merge(tracked, {
          status: 'interrupted',
          error: 'ACP subagent observer session shut down.',
          completedAt: Date.now()
        })
        persist(state, tracked, true)
      }
    }
    append(state, PLAN_CUSTOM_TYPE, { op: 'clear' })
    binding = undefined
    stopTimer(state)
    for (const unsubscribe of state.unsubscribe) unsubscribe()
    if (globals[OWNER] === state) delete globals[OWNER]
  }

  pi.on('session_start', (_event, context) => {
    shutdown()
    const ctx = context as Context | undefined
    const sessionId = ctx?.sessionManager?.getSessionId()
    if (
      !sessionId ||
      ctx?.sessionManager?.getHeader?.()?.parentSession ||
      (ctx?.mode !== 'rpc' && process.env.PI_ACP !== '1')
    )
      return
    // ACP has one root RPC session per process. SDK children inherit mode/env and share the
    // bus; first activation owns the bridge, just as pi-subagents' public registry does.
    if (globals[OWNER]) return
    const state: Binding = { sessionId, agents: new Map(), unsubscribe: [], busy: false }
    binding = state
    globals[OWNER] = state

    const lifecycle =
      (fallback: string): BusHandler =>
      data => {
        const payload = object(data)
        if (!payload || typeof payload.id !== 'string') return
        const record = getRecord(payload.id)
        // The public registry exposes top-level records only. In particular, never let a root
        // lifecycle event persist to a child transcript or another resumed root session.
        if (record && record.rootSessionId !== undefined && record.rootSessionId !== sessionId) return
        if (!record && payload.rootSessionId !== undefined && payload.rootSessionId !== sessionId) return
        let tracked = state.agents.get(payload.id)
        if (!tracked) {
          tracked = { agent: { id: payload.id, status: fallback }, dirty: true, needsFinal: false }
          state.agents.set(payload.id, tracked)
        }
        const patch = { ...fields(record ?? {}), ...fields(payload) }
        // Steering/compaction are activities, not replacements for a registry's execution state.
        if (typeof payload.status !== 'string' && ['completed', 'failed'].includes(fallback)) {
          patch.status =
            record && typeof record.status === 'string' && !isActive(record.status) ? record.status : fallback
        }
        patch.status ??= tracked.agent.status
        if (
          typeof patch.startedAt === 'number' &&
          typeof tracked.agent.startedAt === 'number' &&
          patch.startedAt > tracked.agent.startedAt &&
          typeof patch.status === 'string' &&
          isActive(patch.status)
        ) {
          for (const key of ['completedAt', 'durationMs', 'result', 'error']) delete tracked.agent[key]
          tracked.dirty = true
        }
        merge(tracked, patch)
        if (record) tracked.agent.observedAt = Date.now()
        tracked.needsFinal = !isActive(tracked.agent.status)
        persist(state, tracked, tracked.needsFinal)
        ensureTimer(state)
        if (tracked.needsFinal) void reconcile(state)
      }
    for (const status of ['created', 'started', 'completed', 'failed', 'steered', 'compacted']) {
      state.unsubscribe.push(pi.events.on(`subagents:${status}`, lifecycle(status)))
    }
    for (const op of ['snapshot', 'update'] as const) {
      state.unsubscribe.push(
        pi.events.on(`plan:${op}`, data => {
          const payload = object(data)
          if (payload) append(state, PLAN_CUSTOM_TYPE, { op, ...payload })
        })
      )
    }
  })
  pi.on('session_shutdown', shutdown)
}
