import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import todoAcp, { parseTodoMd } from '../../src/extensions/todo-acp.js'
import { applyPlanEntry, newPlanState, parsePlanEntry, toPlanEntries } from '../../src/acp/plan-bridge.js'

type Api = Parameters<typeof todoAcp>[0]
type Handler = Parameters<Api['on']>[1]
type Event = Parameters<Handler>[0]
type Context = Parameters<Handler>[1]
interface Snapshot {
  op: string
  ns: string
  seq: number
  items: { id: string; title: string; status: string }[]
}

let temp: string
let savedEnv: Record<string, string | undefined>
const envKeys = ['PI_CODING_AGENT_DIR', 'PI_TODO_DIR', 'PI_ACP']

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  temp = mkdtempSync(join(tmpdir(), 'todo-acp-'))
  process.env.PI_CODING_AGENT_DIR = join(temp, 'agent')
  delete process.env.PI_TODO_DIR
  delete process.env.PI_ACP
})
afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(temp, { recursive: true, force: true })
})

function plan(id: string): string {
  return join(temp, 'agent', 'plans', id, 'TODO.md')
}
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
function bridge(id: string, cwd = join(temp, 'project')) {
  mkdirSync(cwd, { recursive: true })
  const hooks = new Map<string, Handler[]>()
  const snapshots: Snapshot[] = []
  const ctx: Context = { cwd, mode: 'rpc', sessionManager: { getSessionId: () => id } }
  const api: Api = {
    on(name, handler) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler])
    },
    appendEntry(type, data) {
      assert.equal(type, 'acp:plan')
      snapshots.push(data as Snapshot)
      return `entry-${snapshots.length}`
    }
  }
  todoAcp(api)
  function fire(name: string, event: Event = {}) {
    return hooks
      .get(name)
      ?.map(handler => handler(event, ctx))
      .at(-1)
  }
  function tool(toolName: string, path: string, mutate?: () => void, isError = false, toolCallId = 'call') {
    fire('tool_execution_start', { toolName, toolCallId, args: { path } })
    mutate?.()
    fire('tool_execution_end', { toolName, toolCallId, isError })
  }
  function prompt(): string | undefined {
    return (fire('before_agent_start', { systemPrompt: 'Original prompt' }) as { systemPrompt: string } | undefined)
      ?.systemPrompt
  }
  return { api, ctx, hooks, snapshots, fire, tool, prompt }
}

test('human TODO files are untouched and ignored; only the normalized session plan produces snapshots', () => {
  const human = join(temp, 'project', 'TODO.md')
  const nested = join(temp, 'project', 'nested', 'TODO.md')
  put(human, '- [ ] Human task\n')
  put(nested, '- [x] Nested human task\n')
  const b = bridge('session-a')
  b.fire('session_start')
  assert.deepEqual(b.snapshots.at(-1)?.items, [])
  assert.equal(readFileSync(human, 'utf8'), '- [ ] Human task\n')
  assert.equal(readFileSync(nested, 'utf8'), '- [x] Nested human task\n')
  assert.equal(statSync(plan('session-a')).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(plan('session-a'))).mode & 0o777, 0o700)
  const prompt = b.prompt()!
  assert.ok(prompt.startsWith('Original prompt'))
  assert.ok(prompt.includes(JSON.stringify(plan('session-a'))))
  assert.match(prompt, /- \[ \] pending.*- \[-\] in progress.*- \[x\] done/)
  assert.match(prompt, /Never automatically create, read, move, ignore, or delete repository TODO.md/)
  b.tool('read', human)
  b.tool('write', nested)
  b.tool('edit', join(temp, 'other', 'TODO.md'))
  assert.equal(b.snapshots.length, 1)
  const normalized = join(dirname(plan('session-a')), 'child', '..', 'TODO.md')
  b.tool('write', normalized, () => put(plan('session-a'), '- [ ] Start\n- [-] Working\n- [x] Finished\n'))
  assert.deepEqual(b.snapshots.at(-1), {
    op: 'snapshot',
    ns: 'todo',
    seq: 2,
    items: [
      { id: 'start', title: 'Start', status: 'pending' },
      { id: 'working', title: 'Working', status: 'in_progress' },
      { id: 'finished', title: 'Finished', status: 'done' }
    ]
  })
  b.tool('read', relative(b.ctx.cwd, plan('session-a')))
  assert.equal(b.snapshots.length, 2, 'unchanged reads are signature-deduplicated')
  // These titles have the same slug; renames must still produce an update.
  b.tool('edit', plan('session-a'), () => put(plan('session-a'), '- [ ] START!\n'))
  b.tool('edit', plan('session-a'), () => put(plan('session-a'), '- [ ] Start!\n'))
  assert.equal(b.snapshots.at(-1)?.items[0].title, 'Start!')
  assert.equal(b.snapshots.length, 4)
  assert.equal(readFileSync(human, 'utf8'), '- [ ] Human task\n')
})

test('instances isolate sessions even in one cwd; resume reuses the plan across cwd changes', () => {
  const a = bridge('a')
  const b = bridge('b')
  a.fire('session_start')
  b.fire('session_start')
  a.tool('write', plan('a'), () => put(plan('a'), '- [x] Session A\n'))
  b.tool('read', plan('a'))
  assert.deepEqual(b.snapshots.at(-1)?.items, [])
  b.tool('write', plan('b'), () => put(plan('b'), '- [-] Session B\n'))
  assert.equal(a.snapshots.at(-1)?.items[0].title, 'Session A')
  assert.ok(a.prompt()?.includes(JSON.stringify(plan('a'))))
  assert.ok(b.prompt()?.includes(JSON.stringify(plan('b'))))
  a.fire('session_shutdown')
  const resumed = bridge('a', join(temp, 'different-project'))
  resumed.fire('session_start', { reason: 'resume' })
  assert.deepEqual(resumed.snapshots.at(-1)?.items, a.snapshots.at(-1)?.items)
  assert.equal(existsSync(join(resumed.ctx.cwd, 'TODO.md')), false)
  assert.equal(process.env.PI_TODO_DIR, undefined, 'no session-specific process environment mutation')
})

test('fork seeds the parent header id plan once without changing the parent; new sessions never copy it', () => {
  const parentText = '- [-] Parent work\n'
  put(plan('parent'), parentText)
  const sessionFile = join(temp, 'misleading-filename.jsonl')
  put(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'parent' }) + '\n')
  const fork = bridge('fork')
  fork.fire('session_start', { reason: 'fork', previousSessionFile: sessionFile })
  assert.equal(readFileSync(plan('fork'), 'utf8'), parentText)
  assert.equal(fork.snapshots.at(-1)?.items[0].title, 'Parent work')
  fork.tool('edit', plan('fork'), () => put(plan('fork'), '- [x] Fork work\n'))
  assert.equal(readFileSync(plan('parent'), 'utf8'), parentText)
  fork.fire('session_start', { reason: 'fork', previousSessionFile: sessionFile })
  assert.equal(readFileSync(plan('fork'), 'utf8'), '- [x] Fork work\n', 'existing fork plans are not overwritten')
  const fresh = bridge('new')
  fresh.fire('session_start', { reason: 'new', previousSessionFile: sessionFile })
  assert.equal(readFileSync(plan('new'), 'utf8'), '')
  assert.deepEqual(fresh.snapshots.at(-1)?.items, [])
  put(sessionFile, '{invalid json\n')
  const malformed = bridge('malformed')
  malformed.fire('session_start', { reason: 'fork', previousSessionFile: sessionFile })
  assert.deepEqual(malformed.snapshots.at(-1)?.items, [])
})

test('empty and deleted plans clear snapshots, including shell deletion of the parent directory', () => {
  put(plan('a'), '- [ ] Task\n')
  const b = bridge('a')
  b.fire('session_start')
  b.tool('write', plan('a'), () => put(plan('a'), ''))
  assert.deepEqual(b.snapshots.at(-1)?.items, [])
  b.tool('write', plan('a'), () => put(plan('a'), '- [ ] Task\n'))
  rmSync(dirname(plan('a')), { recursive: true })
  b.fire('tool_execution_end', { toolName: 'bash', toolCallId: 'shell', isError: true })
  assert.deepEqual(b.snapshots.at(-1)?.items, [])
  assert.equal(existsSync(plan('a')), false, 'refresh does not recreate deleted plans')
  b.fire('tool_execution_end', { toolName: 'bash', toolCallId: 'shell-again' })
  assert.equal(b.snapshots.length, 4, 'empty snapshot is deduplicated')
  const resumed = bridge('a')
  resumed.fire('session_start', { reason: 'resume' })
  assert.deepEqual(resumed.snapshots.at(-1)?.items, [])
})

test('failed tool calls do not retain pending paths, and shutdown clears unfinished calls', () => {
  const b = bridge('a')
  b.fire('session_start')
  b.tool('write', plan('a'), undefined, true, 'failed')
  put(plan('a'), '- [ ] Changed outside the tool\n')
  b.fire('tool_execution_end', { toolCallId: 'failed', toolName: 'write' })
  assert.equal(b.snapshots.length, 1, 'failed call must not refresh on a later unrelated end event')
  b.fire('tool_execution_start', { toolCallId: 'unfinished', toolName: 'write', args: { path: plan('a') } })
  b.fire('session_shutdown')
  b.fire('session_start', { reason: 'resume' })
  put(plan('a'), '- [x] Another outside change\n')
  b.fire('tool_execution_end', { toolCallId: 'unfinished', toolName: 'write' })
  assert.equal(b.snapshots.length, 2)
  b.tool('read', plan('a'))
  assert.equal(b.snapshots.at(-1)?.items[0].status, 'done')
})

test('reload registers fresh hooks and restores the external plan without a process-global guard', () => {
  const old = bridge('a')
  old.fire('session_start')
  old.tool('write', plan('a'), () => put(plan('a'), '- [ ] Before reload\n'))
  old.fire('session_shutdown', { reason: 'reload' })
  const reloaded = bridge('a')
  reloaded.ctx.sessionManager = {
    getSessionId: () => 'a',
    getEntries: () => old.snapshots.map(data => ({ type: 'custom', customType: 'acp:plan', data }))
  }
  reloaded.fire('session_start', { reason: 'reload' })
  assert.equal(reloaded.snapshots.at(-1)?.items[0].title, 'Before reload')
  reloaded.tool('edit', plan('a'), () => put(plan('a'), '- [x] After reload\n'))
  assert.equal(reloaded.snapshots.at(-1)?.items[0].status, 'done')
  assert.equal(old.snapshots.length, 2)
  const state = newPlanState()
  for (const snapshot of [...old.snapshots, ...reloaded.snapshots]) {
    assert.equal(applyPlanEntry(state, parsePlanEntry(snapshot)!), true)
  }
  assert.equal(toPlanEntries(state)[0].content, 'After reload')
  assert.equal(toPlanEntries(state)[0].status, 'completed')
})

test('explicit plan roots remain session-specific; inactive or unidentified sessions never use repository TODO', () => {
  process.env.PI_TODO_DIR = join(temp, 'explicit-plans')
  const b = bridge('a')
  b.fire('session_start')
  const explicit = join(temp, 'explicit-plans', 'a', 'TODO.md')
  assert.equal(existsSync(explicit), true)
  assert.ok(b.prompt()?.includes(JSON.stringify(explicit)))
  b.tool('write', explicit, () => put(explicit, '- [ ] Explicit\n'))
  assert.equal(b.snapshots.at(-1)?.items[0].title, 'Explicit')
  const inactive = bridge('inactive')
  inactive.ctx.mode = 'tui'
  inactive.fire('session_start')
  assert.equal(inactive.snapshots.length, 0)
  assert.equal(inactive.prompt(), undefined)
  assert.equal(existsSync(join(temp, 'explicit-plans', 'inactive')), false)
  for (const getter of [
    () => undefined,
    () => '../escape',
    () => {
      throw new Error('unavailable')
    }
  ]) {
    const unknown = bridge('unused')
    unknown.ctx.sessionManager = { getSessionId: getter }
    assert.doesNotThrow(() => unknown.fire('session_start'))
    assert.equal(unknown.prompt(), undefined)
    assert.deepEqual(unknown.snapshots.at(-1)?.items, [])
    assert.equal(existsSync(join(unknown.ctx.cwd, 'TODO.md')), false)
  }
})

test('parser preserves supported markers, section labels, and duplicate task identities', () => {
  assert.deepEqual(
    parseTodoMd('# TODO\n- [ ] Same\n- [/] Same\n# Verification\n* [~] Running\n+ [X] Done\n- [?] Ignore\n'),
    [
      { id: 'same', title: 'Same', status: 'pending' },
      { id: 'same-2', title: 'Same', status: 'in_progress' },
      { id: 'running', title: 'Running', status: 'in_progress', kind: 'verification' },
      { id: 'done', title: 'Done', status: 'done', kind: 'verification' }
    ]
  )
})
