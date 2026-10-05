import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' },
    messageId: 'm1'
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' },
    messageId: 'm1'
  })
})

test('PiAcpSession: emits bash as a terminal when the client supports terminals', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCapabilities: { terminal: true }
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: process.cwd() }
  })
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[1]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[1]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'running' }
  })
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.equal((conn.updates[2]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[2]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'done' },
    terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null }
  })
  assert.equal((conn.updates[2]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: emits bash as content text blocks when the client lacks terminals', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  // No clientCapabilities → terminal-less fallback.
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  // All three emissions correlate to the same tool call id (the fallback path must not mint new ids).
  for (const entry of conn.updates) {
    assert.equal((entry.update as any).toolCallId, 't1')
  }

  // Initial tool_call renders as a proper tool call: raw command as structured input, no terminal.
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).content, undefined)
  assert.equal((conn.updates[0]!.update as any)._meta, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).rawInput, { command: 'ls' })

  // Output arrives as a content text block plus structured rawOutput (not terminal _meta).
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: 'running' } }
  ])
  assert.deepEqual((conn.updates[1]!.update as any).rawOutput, { content: [{ type: 'text', text: 'running' }] })
  assert.equal((conn.updates[1]!.update as any)._meta, undefined)

  // Completion carries the full output as content + rawOutput; exit code 0 is not appended.
  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.deepEqual((conn.updates[2]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: 'done' } }
  ])
  assert.deepEqual((conn.updates[2]!.update as any).rawOutput, { content: [{ type: 'text', text: 'done' }] })
  assert.equal((conn.updates[2]!.update as any)._meta, undefined)
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: handles extension select via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'pi-ui-ui-1',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: handles extension confirm via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'no' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: sends cancelled response when ACP confirm is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-5', method: 'confirm', title: 'Continue?' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', cancelled: true }])
})

test('PiAcpSession: cancels unsupported input and editor extension UI requests with visible fallback', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Enter name' })
  proc.emit({ type: 'extension_ui_request', id: 'ui-4', method: 'editor', title: 'Edit text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-3', cancelled: true },
    { id: 'ui-4', cancelled: true }
  ])
  assert.equal(conn.updates.length, 2)
  assert.match((conn.updates[0]!.update as any).content.text, /input UI request is not supported/)
  assert.match((conn.updates[1]!.update as any).content.text, /editor UI request is not supported/)
})

test('PiAcpSession: formats provider errors compactly and omits volatile gateway details', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_end',
    message: {
      stopReason: 'error',
      errorMessage:
        '429 {"error":{"message":"The request limited providers for this model and they are currently at capacity.","type":"rate_limit_exceeded"},"statusCode":429,"providerMetadata":{"gateway":{"routing":{"resolvedProvider":"baseten","fallbacksAvailable":["fireworks","baseten"]}},"requestId":"volatile-request-id"}}'
    }
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(
    (conn.updates[0]!.update as any).content.text,
    '\n\n⚠️ **Provider error (429) from baseten**\nThe request limited providers for this model and they are currently at capacity.\nProviders tried: fireworks, baseten.'
  )
  assert.equal((conn.updates[0]!.update as any).content.text.includes('volatile-request-id'), false)
})

test('PiAcpSession: suppresses duplicate provider errors during retries', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const error = '429 {"error":{"message":"Provider at capacity"},"statusCode":429,"requestId":"different"}'
  proc.emit({ type: 'message_end', message: { stopReason: 'error', errorMessage: error } } as any)
  proc.emit({
    type: 'message_end',
    message: { stopReason: 'error', errorMessage: error.replace('different', 'another') }
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.match((conn.updates[0]!.update as any).content.text, /Provider at capacity/)
})

test('PiAcpSession: preserves readable plain-text provider errors', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'Provider unavailable' } } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal((conn.updates[0]!.update as any).content.text, '\n\n⚠️ **Provider error**\nProvider unavailable')
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' }, messageId: 'm1' },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' }, messageId: 'm1' }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from edits array when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'needle', newText: 'replacement' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from stringified edits array', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-string-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: JSON.stringify([{ oldText: 'needle', newText: 'replacement' }]) }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt stays open through retry runs until agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000 })
  proc.emit({ type: 'agent_end', willRetry: true })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_settled' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: tags extension notify chunks with severity in _meta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'MCP: connection failed',
    notifyType: 'error'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'MCP: connection failed' },
    _meta: { piAcp: { notify: { level: 'error' } } }
  })
  assert.deepEqual(proc.extensionUiResponses[0], { id: 'n1', cancelled: true })
})

test('PiAcpSession: defaults notify severity to info when notifyType is absent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n2',
    method: 'notify',
    message: 'heads up'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    piAcp: { notify: { level: 'info' } }
  })
})

test('PiAcpSession: assigns a fresh messageId after message_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } })
  proc.emit({ type: 'message_start', message: {} })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => (u.update as any).messageId),
    ['m1', 'm2']
  )
})

test('PiAcpSession: emits usage_update from session stats on agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
    contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 }
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'agent_settled' })
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const usageUpdate = conn.updates.find(u => (u.update as any).sessionUpdate === 'usage_update')
  assert.ok(usageUpdate)
  assert.deepEqual(usageUpdate.update, {
    sessionUpdate: 'usage_update',
    used: 60000,
    size: 200000,
    cost: { amount: 0.45, currency: 'USD' }
  })
})

test('PiAcpSession: omits usage_update when pi reports no contextUsage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { tokens: { input: 1, output: 1, total: 2 }, cost: 0 }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'agent_settled' })
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  assert.equal(
    conn.updates.find(u => (u.update as any).sessionUpdate === 'usage_update'),
    undefined
  )
})

test('PiAcpSession: takeTurnUsage returns and clears the last turn usage snapshot', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 }
  }

  const session = new PiAcpSession({
    sessionId: 's2',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  proc.emit({ type: 'agent_settled' })
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const first = (session as any).takeTurnUsage()
  assert.deepEqual(first, {
    totalTokens: 15,
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 0,
    cachedWriteTokens: 0
  })
  assert.equal((session as any).takeTurnUsage(), null)
})

test('PiAcpSession: bridges input extension UI to a form elicitation when the client supports it', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextElicitationResponse = { action: 'accept', content: { text: 'user typed this' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCapabilities: { elicitation: { form: {} } } as any
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'input',
    title: 'Enter a value',
    placeholder: 'type something...'
  } as any)

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req: any = conn.elicitationRequests[0]
  assert.equal(req.sessionId, 's1')
  assert.equal(req.mode, 'form')
  assert.equal(req.message, 'Enter a value')
  assert.deepEqual(req.requestedSchema.properties.text, {
    type: 'string',
    title: 'type something...',
    description: 'type something...'
  })

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'user typed this' }])
})

test('PiAcpSession: bridges editor extension UI with prefill as the form default', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextElicitationResponse = { action: 'decline' }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCapabilities: { elicitation: { form: {} } } as any
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'editor',
    title: 'Edit some text',
    prefill: 'Line 1\nLine 2'
  } as any)

  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  const req: any = conn.elicitationRequests[0]
  assert.equal(req.message, 'Edit some text')
  assert.deepEqual(req.requestedSchema.properties.text, {
    type: 'string',
    title: 'Text',
    default: 'Line 1\nLine 2'
  })

  // decline → cancelled on pi's side
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', cancelled: true }])
})

test('PiAcpSession: codemode inner calls stay inside the codemode card', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Event order captured from `pi --mode rpc` 1.0.0 running a two-call codemode script.
  const code = 'const a = await tools.bash({command:"echo one"})\nreturn a'
  const running = { id: 'c1/?', name: 'bash', args: '{"command":"echo one"}', status: 'running' }
  const done = { id: 'c1/1', name: 'bash', args: '{"command":"echo one"}', status: 'ok', durationMs: 16 }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'codemode', args: { code } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'c1',
    toolName: 'codemode',
    partialResult: { content: [], details: { calls: [running] } }
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'c1/1',
    toolName: 'bash',
    args: { command: 'echo one' },
    parentToolCallId: 'c1'
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'c1/1',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'one\n' }] },
    parentToolCallId: 'c1'
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'c1/1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'one\n' }] },
    isError: false,
    parentToolCallId: 'c1'
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'codemode',
    result: {
      content: [
        { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'text', text: '"one\\n"' }
      ],
      details: { calls: [done] }
    },
    isError: false
  })

  await new Promise(r => setTimeout(r, 0))

  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.toolCallId),
    ['c1', 'c1', 'c1'],
    'no separate cards for nested calls'
  )
  assert.equal(updates[0].sessionUpdate, 'tool_call')
  assert.equal(updates[0].title, 'codemode: const a = await tools.bash({command:"echo one"})')
  assert.equal(updates[1].content[0].content.text, '… bash {"command":"echo one"}')
  assert.equal(updates[2].status, 'completed')
  assert.equal(updates[2].content[0].content.text, '✓ bash {"command":"echo one"} 16ms\n\n"one\\n"')

  proc.emit({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'codemode',
      content: [],
      details: { calls: [done] },
      nestedCalls: {
        complete: true,
        calls: [{ id: 'c1/1', name: 'bash', status: 'ok', arguments: { command: 'echo one' } }]
      }
    }
  })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(conn.updates.length, 3, 'the durable record does not duplicate already-rendered codemode calls')
})

test('PiAcpSession: non-codemode parents retain failed and deeper nested calls in their final card', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'd', toolName: 'delegate', args: {} })
  for (const [id, parent, name] of [
    ['d/1', 'd', 'helper'],
    ['d/1/1', 'd/1', 'mcp__agent_memory__get_memory']
  ]) {
    proc.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: {}, parentToolCallId: parent })
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: name,
      isError: true,
      result: { content: [{ type: 'text', text: 'fixture failure' }] },
      parentToolCallId: parent
    })
  }
  const result = { content: [{ type: 'text', text: 'delegation failed' }] }
  proc.emit({ type: 'tool_execution_end', toolCallId: 'd', toolName: 'delegate', result, isError: true })
  proc.emit({
    type: 'message_end',
    message: {
      ...result,
      role: 'toolResult',
      toolCallId: 'd',
      toolName: 'delegate',
      isError: true,
      nestedCalls: {
        complete: true,
        calls: [
          { id: 'd/1', name: 'helper', arguments: {}, status: 'error', error: 'fixture failure' },
          {
            id: 'd/1/1',
            name: 'mcp__agent_memory__get_memory',
            arguments: { id: 'fixture' },
            status: 'error',
            error: 'fixture failure'
          }
        ]
      }
    }
  })
  await new Promise(r => setTimeout(r, 0))
  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.toolCallId),
    ['d', 'd', 'd'],
    'nested events never create extra cards'
  )
  assert.equal(updates[2].status, 'failed')
  assert.match(updates[2].content[0].content.text, /✗ helper/)
  assert.match(updates[2].content[0].content.text, /✗ agent_memory\/get_memory \{"id":"fixture"\}/)
  assert.match(updates[2].content[0].content.text, /delegation failed$/)
  session.dispose()
})
