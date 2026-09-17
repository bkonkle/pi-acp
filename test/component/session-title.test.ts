import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// pi emits `session_info_changed` for ANY session-name change: an extension's
// setSessionName (e.g. auto-title), the /name command, or RPC set_session_name.
// The adapter forwards it as an ACP session_info_update title.
function nameChanged(name: string | undefined) {
  return { type: 'session_info_changed', name }
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

test('adapter surfaces a session-name change as session_info_update with the title', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  // The auto-title extension calls pi.setSessionName(); pi emits this event.
  proc.emit(nameChanged('fix auth redirect'))
  await flush()

  const updates = titleUpdates(conn)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].title, 'fix auth redirect')
  assert.ok(updates[0].updatedAt, 'updatedAt is set for the ACP client')
})

test('adapter emits each title refresh so clients see the latest name', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  proc.emit(nameChanged('first title'))
  proc.emit(nameChanged('refined title after follow-up'))
  await flush()

  const updates = titleUpdates(conn)
  assert.deepEqual(
    updates.map(u => u.title),
    ['first title', 'refined title after follow-up']
  )
})

test('adapter ignores empty or missing names', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  proc.emit(nameChanged(''))
  proc.emit(nameChanged(undefined))
  proc.emit(nameChanged('   '))
  await flush()

  assert.equal(titleUpdates(conn).length, 0)
})

test('custom entries from user extensions do not produce title updates', async () => {
  const proc = new FakePiRpcProcess()
  const conn = newSession(proc)

  // auto-title writes its private marker entry; titles must arrive via
  // session_info_changed instead.
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'auto-title:name',
      data: { title: 'from marker entry', source: 'auto' },
      id: 'e1',
      timestamp: ''
    }
  })
  await flush()

  assert.equal(titleUpdates(conn).length, 0)
})
