import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, writeFile, appendFile, stat, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import extension from '../../src/pi-extension.js'

const managerKey = Symbol.for('pi-subagents:manager')
const globals = globalThis as Record<symbol, unknown>
type RecordData = Record<string, unknown>

function harness(bus = new EventEmitter()) {
  const hooks = new Map<string, ((event: unknown, ctx: unknown) => void | Promise<void>)[]>()
  const entries: { type: string; data: RecordData }[] = []
  const appended = new EventEmitter()
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler])
    },
    events: {
      on(name: string, handler: (data: unknown) => void) {
        bus.on(name, handler)
        return () => {
          bus.off(name, handler)
        }
      }
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data: data as RecordData })
      appended.emit('append', data)
      return String(entries.length)
    }
  }
  extension(pi)
  return {
    pi,
    bus,
    entries,
    appended,
    async start(mode = 'rpc', id = 'root', parentSession?: string) {
      for (const hook of hooks.get('session_start') ?? []) {
        await hook({}, { mode, sessionManager: { getSessionId: () => id, getHeader: () => ({ parentSession }) } })
      }
    },
    async shutdown() {
      for (const hook of hooks.get('session_shutdown') ?? []) await hook({}, {})
    },
    agents(id: string) {
      return entries.filter(e => e.type === 'acp:subagents' && e.data.id === id).map(e => e.data)
    }
  }
}
function registry(records: Map<string, RecordData>) {
  globals[managerKey] = { getRecord: (id: string) => records.get(id) }
}
function running(id: string, extra: RecordData = {}): RecordData {
  return {
    id,
    status: 'running',
    type: 'Explore',
    description: 'Inspect auth',
    rootSessionId: 'root',
    startedAt: 1000,
    toolUses: 0,
    ...extra
  }
}
// Reconciliation with no output file only awaits an already-resolved tail promise.
async function tick(t: TestContext, milliseconds: number) {
  t.mock.timers.tick(milliseconds)
  await Promise.resolve()
  await Promise.resolve()
}

test('session-bound bridge survives reload without duplicate handlers and interrupts before shutdown', async t => {
  const previous = globals[managerKey]
  t.after(() => {
    globals[managerKey] = previous
  })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const records = new Map([['a', running('a')]])
  registry(records)
  const old = harness()
  t.after(() => old.shutdown())
  extension(old.pi) // package + explicit -e on the same API
  assert.equal(old.bus.listenerCount('subagents:started'), 0)
  await old.start()
  old.bus.emit('subagents:started', { id: 'a' })
  assert.equal(old.agents('a').length, 1)
  await old.shutdown()
  assert.equal(old.agents('a').at(-1)?.status, 'interrupted')
  assert.equal(old.bus.eventNames().length, 0)
  const count = old.entries.length
  await tick(t, 10000)
  assert.equal(old.entries.length, count)

  const fresh = harness(old.bus)
  t.after(() => fresh.shutdown())
  await fresh.start()
  assert.equal(fresh.entries.length, 0, 'resume activation must not clear replayed historic cards')
  fresh.bus.emit('subagents:started', { id: 'a' })
  assert.equal(fresh.agents('a').length, 1)
  assert.equal(old.entries.length, count)
  assert.equal(old.bus.listenerCount('subagents:started'), 1)
  fresh.bus.emit('plan:snapshot', { entries: [{ content: 'Do work' }] })
  assert.equal(fresh.entries.at(-1)?.type, 'acp:plan')
  await fresh.shutdown()
  await fresh.start('rpc', 'other-root')
  fresh.bus.emit('subagents:started', { id: 'a' })
  assert.equal(fresh.agents('a').length, 2, 'map reset; foreign registry record ignored')
})

test('TUI stays inert and inherited RPC/env in SDK children cannot bridge the shared root bus', async t => {
  const previous = globals[managerKey]
  const env = process.env.PI_ACP
  delete process.env.PI_ACP
  t.after(() => {
    globals[managerKey] = previous
    if (env === undefined) delete process.env.PI_ACP
    else process.env.PI_ACP = env
  })
  registry(
    new Map([
      ['a', running('a')],
      ['foreign', running('foreign', { rootSessionId: 'elsewhere' })],
      ['rpc-spawn', running('rpc-spawn', { rootSessionId: undefined })]
    ])
  )
  const bus = new EventEmitter()
  const tui = harness(bus)
  const root = harness(bus)
  const child = harness(bus)
  t.after(async () => {
    await child.shutdown()
    await root.shutdown()
    await tui.shutdown()
  })
  await tui.start('tui')
  assert.equal(bus.eventNames().length, 0)
  await child.start('rpc', 'persisted-child', '/tmp/root.jsonl')
  assert.equal(bus.eventNames().length, 0, 'persisted SDK child excluded even before root binds')
  await root.start()
  process.env.PI_ACP = '1'
  await child.start('rpc', 'sdk-child')
  bus.emit('subagents:started', { id: 'a' })
  bus.emit('subagents:started', { id: 'foreign' })
  bus.emit('subagents:started', { id: 'rpc-spawn' })
  bus.emit('plan:update', { id: 'step', status: 'completed' })
  assert.equal(root.agents('a').length, 1)
  assert.equal(root.agents('foreign').length, 0)
  assert.equal(
    root.agents('rpc-spawn').length,
    1,
    'public RPC spawns omit rootSessionId but still belong to the first-owner root manager'
  )
  assert.deepEqual(child.entries, [])
  assert.deepEqual(tui.entries, [])
})

test('specific terminal payload wins over stale registry and retains result/error and execution metadata', async t => {
  const previous = globals[managerKey]
  t.after(() => {
    globals[managerKey] = previous
  })
  const h = harness()
  t.after(() => h.shutdown())
  registry(new Map([['a', running('a', { toolCallId: 'tool-1', sessionFile: '/tmp/session.jsonl' })]]))
  await h.start()
  h.bus.emit('subagents:started', { id: 'a' })
  h.bus.emit('subagents:failed', {
    id: 'a',
    status: 'aborted',
    result: 'partial result',
    error: 'Cancelled',
    completedAt: 4000,
    durationMs: 2500,
    toolUses: 3
  })
  const terminal = h.agents('a').at(-1)!
  assert.equal(terminal.status, 'aborted')
  assert.equal(terminal.error, 'Cancelled')
  assert.equal(terminal.result, 'partial result')
  assert.equal(terminal.durationMs, 2500)
  assert.equal(terminal.toolUses, 3)
  assert.equal(terminal.toolCallId, 'tool-1')
  assert.equal(terminal.sessionFile, '/tmp/session.jsonl')
  assert.equal(terminal.rootSessionId, 'root')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.agents('a').at(-1)?.status, 'aborted')
})

test('dirty snapshots wait 2s, genuine resume preserves startedAt, and terminal text is bounded', async t => {
  const previous = globals[managerKey]
  t.after(() => {
    globals[managerKey] = previous
  })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const records = new Map([['a', running('a')]])
  registry(records)
  const h = harness()
  t.after(() => h.shutdown())
  await h.start()
  h.bus.emit('subagents:started', { id: 'a' })
  records.get('a')!.toolUses = 2
  h.bus.emit('subagents:compacted', { id: 'a' })
  await tick(t, 1000)
  assert.equal(h.agents('a').length, 1)
  await tick(t, 1000)
  assert.equal(h.agents('a').at(-1)?.toolUses, 2)
  assert.equal(h.agents('a').length, 2)
  h.bus.emit('subagents:completed', { id: 'a', result: 'é'.repeat(40000), error: 'x'.repeat(40000) })
  assert.equal(h.agents('a').at(-1)?.status, 'completed', 'terminal event wins over a stale running registry')
  assert.ok(Buffer.byteLength(String(h.agents('a').at(-1)?.result)) <= 32768)
  assert.ok(Buffer.byteLength(String(h.agents('a').at(-1)?.error)) <= 32768)
  await Promise.resolve()
  await Promise.resolve()
  records.set('a', running('a', { startedAt: 5000 }))
  h.bus.emit('subagents:started', { id: 'a' })
  await tick(t, 2000)
  assert.equal(h.agents('a').at(-1)?.startedAt, 5000)
  assert.equal(h.agents('a').at(-1)?.status, 'running')
})

test('silent queued abort, turn-limit completion, and missing registry settle without bus events', async t => {
  const previous = globals[managerKey]
  t.after(() => {
    globals[managerKey] = previous
  })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const records = new Map([
    ['queued', running('queued', { status: 'queued' })],
    ['turn-limit', running('turn-limit')],
    ['evicted', running('evicted')]
  ])
  registry(records)
  const h = harness()
  t.after(() => h.shutdown())
  await h.start()
  for (const id of records.keys()) h.bus.emit('subagents:created', { id })
  records.set('queued', running('queued', { status: 'aborted', error: 'Queued cancellation', completedAt: 1800 }))
  records.set(
    'turn-limit',
    running('turn-limit', { status: 'completed', result: 'Turn ceiling reached', completedAt: 1900 })
  )
  records.delete('evicted')
  // Each real agent's resolved tail promise yields once, so drain via an observable last append.
  const finished = once(h.appended, 'append')
  t.mock.timers.tick(1000)
  await finished
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.agents('queued').at(-1)?.status, 'aborted')
  assert.equal(h.agents('turn-limit').at(-1)?.result, 'Turn ceiling reached')
  assert.equal(h.agents('evicted').at(-1)?.status, 'interrupted')
  assert.match(String(h.agents('evicted').at(-1)?.error), /unavailable/)
  const count = h.entries.length
  await tick(t, 10000)
  assert.equal(h.entries.length, count, 'all settled; timer stopped')
})

test('bounded live/final file previews throttle dirty snapshots; heartbeat observes registry, not activity', async t => {
  const previous = globals[managerKey]
  t.after(() => {
    globals[managerKey] = previous
  })
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-preview-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outputFile = join(dir, 'agent.output')
  await writeFile(outputFile, 'x'.repeat(40000) + '\nLive text')
  await utimes(outputFile, 1, 1)
  const records = new Map([['a', running('a', { outputFile })]])
  registry(records)
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const h = harness()
  t.after(() => h.shutdown())
  await h.start()
  h.bus.emit('subagents:started', { id: 'a' })
  // Dirty output is not persisted before 2s; advance while its async read is busy.
  t.mock.timers.tick(1000)
  const live = once(h.appended, 'append')
  t.mock.timers.tick(1000)
  await live
  const preview = h.agents('a').at(-1)!
  assert.equal(Buffer.byteLength(String(preview.latestOutput)), 32768)
  assert.ok(String(preview.latestOutput).endsWith('\nLive text'))
  assert.equal(preview.lastActivityAt, (await stat(outputFile)).mtimeMs)
  const activity = preview.lastActivityAt
  const heartbeat = once(h.appended, 'append')
  t.mock.timers.tick(10000)
  await heartbeat
  assert.equal(h.agents('a').at(-1)?.lastActivityAt, activity)
  assert.ok(Number(h.agents('a').at(-1)?.observedAt) > Number(preview.observedAt))
  await appendFile(outputFile, '\nFinal answer')
  await utimes(outputFile, 2, 2)
  records.set('a', running('a', { outputFile, status: 'completed', result: 'Done', completedAt: Date.now() }))
  h.bus.emit('subagents:completed', { id: 'a', status: 'completed' })
  const final = once(h.appended, 'append')
  await final
  assert.ok(String(h.agents('a').at(-1)?.latestOutput).endsWith('\nFinal answer'))
  assert.equal(h.agents('a').at(-1)?.lastActivityAt, 2000)
  const count = h.entries.length
  await tick(t, 10000)
  assert.equal(h.entries.length, count)
})
