import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const entry = (data: unknown) => ({
  type: 'entry_appended',
  entry: { type: 'custom', customType: 'acp:subagents', data }
})

function setup() {
  const proc = new FakePiRpcProcess()
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

test('successful Agent launches use only the child execution card; returning its id does not finish background work', async () => {
  const { proc, conn, session } = setup()
  const prompt = 'Inspect authorization. '.repeat(1000)
  const args = { prompt, description: 'Check authorization', subagent_type: 'Explore' }
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'launch', name: 'Agent', arguments: args } }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'launch', toolName: 'Agent', args })
  proc.emit(
    entry({
      id: 'child',
      toolCallId: 'launch',
      description: args.description,
      status: 'running',
      outputFile: '/tmp/child.output'
    })
  )
  const result = {
    content: [{ type: 'text', text: 'Agent started in background.' }],
    details: { agentId: 'child', status: 'background' }
  }
  proc.emit({ type: 'tool_execution_end', toolCallId: 'launch', result })
  await flush()
  assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'tool_call').length, 1)
  let card = conn.updates
    .map(u => u.update)
    .filter(
      u =>
        (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
        u.toolCallId === 'pi-subagent-child'
    )
    .at(-1)
  assert.ok(card?.sessionUpdate === 'tool_call_update')
  assert.equal(card.status, 'in_progress')
  assert.match(String(card.rawInput), /Inspect authorization/)
  assert.ok(String(card.rawInput).length < 2100)
  const finalResult = 'A useful finding\n'.repeat(10000)
  proc.emit(
    entry({
      id: 'child',
      status: 'completed',
      result: finalResult,
      activityTools: [
        { id: 'read', name: 'read', title: 'src/auth.ts', status: 'completed', output: 'Missing permission check' }
      ]
    })
  )
  await flush()
  card = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'pi-subagent-child')
    .at(-1)
  assert.ok(card?.sessionUpdate === 'tool_call_update')
  assert.equal(card.status, 'completed')
  assert.match(JSON.stringify(card.content), /Subagent Output/)
  assert.match(JSON.stringify(card.content), /Missing permission check/)
  assert.ok(JSON.stringify(card).length < 10000)
  assert.ok(!('rawOutput' in card))
  assert.equal(args.prompt, prompt)
  assert.equal(result.content[0].text, 'Agent started in background.')
  session.dispose()
})

test('foreground children correlate by result agentId even without toolCallId in the live registry', async () => {
  const { proc, conn, session } = setup()
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'foreground',
    toolName: 'Agent',
    args: { prompt: 'Check permissions', description: 'Check auth' }
  })
  proc.emit(entry({ id: 'foreground-child', status: 'running' }))
  proc.emit(entry({ id: 'foreground-child', status: 'completed', result: 'A missing permission check.' }))
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'foreground',
    result: { content: [{ type: 'text', text: 'Full result for Pi' }], details: { agentId: 'foreground-child' } }
  })
  await flush()
  const creates = conn.updates.filter(u => u.update.sessionUpdate === 'tool_call')
  assert.equal(creates.length, 1)
  const final = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update')
    .at(-1)
  assert.ok(final?.sessionUpdate === 'tool_call_update')
  assert.equal(final.status, 'completed')
  assert.match(String(final.rawInput), /Check permissions/)
  assert.match(JSON.stringify(final.content), /missing permission check/)
  session.dispose()
})

test('parent cancellation and late launch results do not interrupt background work or update a nonexistent row', async () => {
  const { proc, conn, session } = setup()
  const turn = session.prompt('Launch a background check')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'launch',
    toolName: 'Agent',
    args: { prompt: 'Check permissions' }
  })
  proc.emit(entry({ id: 'child', toolCallId: 'launch', status: 'running' }))
  await session.cancel()
  proc.emit({ type: 'agent_end', messages: [] })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'cancelled')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'launch',
    result: { content: [{ type: 'text', text: 'Agent started in background.' }], details: { agentId: 'child' } }
  })
  await flush()
  const tools = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
  assert.ok(tools.every(u => u.toolCallId === 'pi-subagent-child'))
  assert.equal(tools.at(-1)?.status, 'in_progress')
  session.dispose()
})

test('startup failures stay visible without creating an invalid update for a hidden invocation', async () => {
  const { proc, conn, session } = setup()
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'bad-launch',
    toolName: 'Agent',
    args: { description: 'Check auth', prompt: 'Check permissions' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'bad-launch',
    isError: true,
    result: { content: [{ type: 'text', text: 'Agent type not found' }] }
  })
  await flush()
  const final = conn.updates.at(-1)?.update
  assert.ok(final?.sessionUpdate === 'tool_call')
  assert.equal(final.status, 'failed')
  assert.match(JSON.stringify(final.content), /Agent type not found/)
  assert.ok(!('rawOutput' in final))
  session.dispose()
})

test('result retrieval previews stay bounded while ordinary tools retain full display output', async () => {
  const { proc, conn, session } = setup()
  const output = 'Subagent finding\n'.repeat(10000)
  const result = { content: [{ type: 'text', text: output }], details: { conversation: output } }
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'get',
    toolName: 'get_subagent_result',
    args: { agent_id: 'child' }
  })
  proc.emit({ type: 'tool_execution_update', toolCallId: 'get', partialResult: result })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'get', result })
  await flush()
  const retrieval = conn.updates
    .map(u => u.update)
    .filter(u => (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.toolCallId === 'get')
  for (const row of retrieval) {
    assert.ok(JSON.stringify(row).length < 2000)
    assert.ok(!('rawOutput' in row))
  }
  assert.match(JSON.stringify(retrieval), /Preview only/)
  assert.equal(result.content[0].text, output)
  assert.equal(result.details.conversation, output)
  proc.emit({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: '/tmp/source.ts' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'read', result })
  await flush()
  const ordinary = conn.updates.at(-1)?.update
  assert.ok(ordinary?.sessionUpdate === 'tool_call_update')
  assert.deepEqual(ordinary.rawOutput, result)
  session.dispose()
})

test('the same expandable card keeps errors readable without transcripts and clears them on a successful resume', async () => {
  const { proc, conn, session } = setup()
  proc.emit(
    entry({
      id: 'failed',
      description: 'Check authorization',
      status: 'failed',
      error: 'Language server failed\n'.repeat(1000)
    })
  )
  await flush()
  const first = conn.updates.find(u => u.update.sessionUpdate === 'tool_call')?.update
  assert.ok(first?.sessionUpdate === 'tool_call')
  assert.equal(first.status, 'failed')
  assert.match(JSON.stringify(first.content), /Language server failed/)
  assert.ok(JSON.stringify(first).length < 2500)
  proc.emit(entry({ id: 'failed', status: 'running', startedAt: 10000, workingText: 'OLD RESPONSE' }))
  proc.emit(entry({ id: 'failed', status: 'failed', error: 'New response failed', workingText: '' }))
  await flush()
  const reset = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update')
    .at(-1)
  assert.ok(reset?.sessionUpdate === 'tool_call_update')
  assert.ok(
    !JSON.stringify(reset.content).includes('OLD RESPONSE'),
    'explicit empty response clears the rendered earlier response'
  )
  proc.emit(entry({ id: 'failed', status: 'running', startedAt: 20000 }))
  proc.emit(
    entry({
      id: 'failed',
      status: 'completed',
      startedAt: 20000,
      completedAt: 22000,
      result: 'Permission checks passed.'
    })
  )
  await flush()
  const final = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update')
    .at(-1)
  assert.ok(final?.sessionUpdate === 'tool_call_update')
  assert.equal(final.status, 'completed')
  assert.match(JSON.stringify(final.content), /Permission checks passed/)
  assert.ok(!JSON.stringify(final).includes('Language server failed'))
  assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'tool_call').length, 1)
  session.dispose()
})
