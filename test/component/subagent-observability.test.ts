import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const entry = (customType: string, data: unknown) => ({
  type: 'entry_appended',
  entry: { type: 'custom', customType, data }
})
function setup(proc = new FakePiRpcProcess()) {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 'root',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(conn)
  })
  return { proc, conn, session }
}
function cards(conn: FakeAgentSideConnection) {
  return conn.updates
    .map(u => u.update)
    .filter(
      (u): u is Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }> =>
        (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
        u.toolCallId === 'pi-subagent-child'
    )
}

test('detached agents use native status rows without transcript dumps and retain a clickable output row', async () => {
  const { proc, conn } = setup()
  proc.emit(
    entry('acp:subagents', {
      id: 'child',
      type: 'Explore',
      description: 'Find auth',
      status: 'started',
      startedAt: 1000
    })
  )
  proc.emit(
    entry('acp:subagents', {
      id: 'child',
      status: 'running',
      observedAt: 12_000,
      lastActivityAt: 11_000,
      toolUses: 3,
      latestOutput: 'Reading the auth middleware',
      outputFile: '/tmp/auth output.txt',
      sessionFile: '/tmp/auth.jsonl'
    })
  )
  proc.emit(
    entry('subagents:record', {
      id: 'child',
      status: 'completed',
      result: 'Found a missing authorization check',
      startedAt: 1000,
      completedAt: 15_000
    })
  )
  proc.emit(entry('acp:subagents', { id: 'child', status: 'started', observedAt: 1e100, lastActivityAt: -1 }))
  await flush()
  const rows = cards(conn)
  assert.equal(rows[0].sessionUpdate, 'tool_call')
  assert.equal(rows[0].status, 'in_progress')
  assert.equal(rows[1].status, 'in_progress')
  for (const row of rows) {
    assert.equal(row._meta?.tool_name, 'spawn_agent', 'Zed native subagent renderer contract')
    assert.equal(row._meta?.subagent_session_info, undefined, 'do not advertise an unavailable child preview')
    assert.ok(!JSON.stringify(row).includes('Reading the auth middleware'))
    assert.ok(!JSON.stringify(row).includes('Found a missing authorization check'))
  }
  assert.match(rows[1].title ?? '', /Find auth · 3 tools · 11s/)
  assert.equal(rows[1].rawOutput && (rows[1].rawOutput as { lastActivityAt: number }).lastActivityAt, 11_000)
  const artifacts = conn.updates
    .map(u => u.update)
    .filter(
      u =>
        (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
        u.toolCallId === 'pi-agent-output-child'
    )
  assert.equal(artifacts.length, 1, 'heartbeat and completion do not repeat unchanged file links')
  const artifact = artifacts[0]
  assert.ok(artifact.sessionUpdate === 'tool_call')
  assert.equal(artifact.kind, 'read')
  assert.equal(artifact._meta?.tool_name, undefined, 'file access uses the normal clickable renderer')
  assert.match(JSON.stringify(artifact.content), /file:\/\/\/tmp\/auth%20output.txt/)
  assert.match(JSON.stringify(artifact.content), /file:\/\/\/tmp\/auth.jsonl/)
  assert.deepEqual(artifact.locations, [{ path: '/tmp/auth output.txt' }], 'primary Go to File target')
  assert.equal(rows[2].status, 'completed')
  assert.equal(rows[3].status, 'completed', 'late lifecycle entries must not reopen a finished row')
})

test('idle process death and session disposal close unfinished rows and detach old event handlers', async () => {
  const { proc, conn, session } = setup()
  proc.emit(entry('acp:subagents', { id: 'child', description: 'queued work', status: 'created' }))
  proc.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: '/tmp/missing' } })
  proc.emitExit({ code: 1, signal: null })
  session.dispose()
  proc.emit(entry('acp:subagents', { id: 'child', status: 'running' }))
  await flush()
  assert.equal(cards(conn).at(-1)?.status, 'failed')
  assert.match(cards(conn).at(-1)?.title ?? '', /interrupted/)
  assert.equal(cards(conn).length, 2, 'old process updates cannot revive a disposed session')
  assert.ok(
    conn.updates.some(
      u =>
        u.update.sessionUpdate === 'tool_call_update' && u.update.toolCallId === 'tool' && u.update.status === 'failed'
    )
  )
  const plan = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'plan')
    .at(-1)
  assert.equal(plan?.entries[0].status, 'completed')
  assert.match(plan?.entries[0].content ?? '', /interrupted/)
  assert.equal(await session.prompt('do more'), 'error')
})

test('resume restores active-branch output, marks orphaned execution interrupted, and recognizes a fresh run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'acp-observable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  const records = [
    { type: 'session', id: 'root' },
    { id: 'base', parentId: null, type: 'message', message: { role: 'user', content: 'find auth' } },
    {
      id: 'abandoned',
      parentId: 'base',
      type: 'custom',
      customType: 'acp:subagents',
      data: { id: 'wrong-branch', status: 'error' }
    },
    {
      id: 'active',
      parentId: 'base',
      type: 'custom',
      customType: 'acp:subagents',
      data: {
        id: 'child',
        status: 'running',
        startedAt: 1000,
        observedAt: 9000,
        latestOutput: 'Partial findings',
        outputFile: '/tmp/child.output'
      }
    },
    {
      id: 'plan',
      parentId: 'active',
      type: 'custom',
      customType: 'acp:plan',
      data: { op: 'snapshot', ns: 'todo', seq: 3, items: [{ id: 'fix', title: 'Fix auth', status: 'in_progress' }] }
    }
  ]
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n{incomplete')
  const { proc, conn, session } = setup()
  await session.restoreTracking(path)
  assert.equal(cards(conn).at(-1)?.status, 'failed')
  assert.ok(!JSON.stringify(cards(conn).at(-1)).includes('Partial findings'))
  assert.ok(
    conn.updates.some(u => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'pi-agent-output-child')
  )
  assert.ok(!JSON.stringify(conn.updates).includes('wrong-branch'))
  const plan = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'plan')
    .at(-1)
  assert.equal(plan?.entries[0].content, 'Fix auth')
  proc.emit(entry('acp:subagents', { id: 'child', status: 'running', startedAt: 20_000, observedAt: 20_000 }))
  await flush()
  assert.equal(cards(conn).at(-1)?.status, 'in_progress')
  assert.ok(!JSON.stringify(cards(conn).at(-1)?.content).includes('Partial findings'))
  assert.ok(!JSON.stringify(cards(conn).at(-1)?.content).includes('no longer attached'))
})
