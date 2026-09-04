import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Simulate exactly what pi forwards over RPC for a custom entry:
//   { type: 'entry_appended', entry: { type: 'custom', customType, data, ... } }
function customEntry(customType: string, data: unknown) {
  return {
    type: 'entry_appended',
    entry: { type: 'custom', customType, data, id: 'e' + Math.random().toString(36).slice(2), timestamp: '' }
  }
}

// session.emit() serializes updates on an internal promise chain, so flush the microtask queue.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function titleUpdates(conn: FakeAgentSideConnection): Array<{ title?: string; updatedAt?: string }> {
  return conn.updates
    .map(u => u.update as { sessionUpdate: string; title?: string; updatedAt?: string })
    .filter(u => u.sessionUpdate === 'session_info_update' && typeof u.title === 'string')
}

function newSession(proc: FakePiRpcProcess) {
  const conn = new FakeAgentSideConnection()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return conn
}

test('adapter surfaces an auto-title entry as session_info_update with the title', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  // The user's auto-title extension appends this after generating a name.
  proc.emit(customEntry('acp:session_title', { title: 'Fix auth redirect', source: 'auto' }))
  await flush()

  const updates = titleUpdates(conn)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].title, 'Fix auth redirect')
  assert.ok(updates[0].updatedAt, 'updatedAt is set for the ACP client')
})

test('adapter emits each title refresh so clients see the latest name', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  proc.emit(customEntry('acp:session_title', { title: 'First title' }))
  proc.emit(customEntry('acp:session_title', { title: 'Refined title after 5 turns' }))
  await flush()

  const updates = titleUpdates(conn)
  assert.deepEqual(
    updates.map(u => u.title),
    ['First title', 'Refined title after 5 turns']
  )
})

test('adapter ignores manual-marker entries without a title', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  proc.emit(customEntry('acp:session_title', { source: 'manual' }))
  proc.emit(customEntry('acp:session_title', { title: '   ' }))
  await flush()

  assert.equal(titleUpdates(conn).length, 0)
})
