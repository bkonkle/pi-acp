import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

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

test('subagent invocation previews stay small in streaming and final results without modifying Pi data', async () => {
  const { proc, conn, session } = setup()
  const prompt = 'private prompt '.repeat(10000)
  const output = 'Subagent finding\n'.repeat(10000) + 'FULL RESULT END'
  for (const name of ['Agent', 'get_subagent_result']) {
    const args = { prompt, description: 'Check authorization', subagent_type: 'Explore', agent_id: 'child' }
    const result = { content: [{ type: 'text', text: output }], details: { conversation: output } }
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        toolCall: { id: name, name, arguments: args }
      }
    })
    proc.emit({ type: 'tool_execution_start', toolCallId: name, toolName: name, args })
    proc.emit({ type: 'tool_execution_update', toolCallId: name, partialResult: result })
    proc.emit({ type: 'tool_execution_end', toolCallId: name, result })
    await flush()
    const rows = conn.updates
      .map(u => u.update)
      .filter(u => (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.toolCallId === name)
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.ok(JSON.stringify(row).length < 2000)
      assert.ok(!('rawOutput' in row), 'rawOutput must not bypass the preview limit')
      assert.ok(!JSON.stringify(row).includes('private prompt'))
    }
    const final = rows.at(-1)
    assert.ok(final?.sessionUpdate === 'tool_call_update')
    assert.equal(final.status, 'completed')
    assert.match(JSON.stringify(final.content), /Subagent finding/)
    assert.match(JSON.stringify(final.content), /Preview only/)
    assert.equal(args.prompt, prompt)
    assert.equal(result.content[0].text, output)
    assert.equal(result.details.conversation, output)
  }
  session.dispose()
})

test('ordinary tools keep their full display output and raw data', async () => {
  const { proc, conn, session } = setup()
  const result = { content: [{ type: 'text', text: 'file contents\n'.repeat(1000) }] }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: '/tmp/source.ts' } })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'read', result })
  await flush()
  const final = conn.updates.at(-1)?.update
  assert.ok(final?.sessionUpdate === 'tool_call_update')
  assert.deepEqual(final.rawOutput, result)
  assert.deepEqual(final.content, [{ type: 'content', content: result.content[0] }])
  session.dispose()
})

test('native failures retain accessible error details even when transcripts are disabled', async () => {
  const { proc, conn, session } = setup()
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'acp:subagents',
      data: {
        id: 'failed',
        description: 'Check authorization',
        status: 'failed',
        error: 'Language server failed\n'.repeat(1000)
      }
    }
  })
  await flush()
  const native = conn.updates.find(
    u => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'pi-subagent-failed'
  )?.update
  const details = conn.updates.find(
    u => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'pi-agent-output-failed'
  )?.update
  assert.ok(native?.sessionUpdate === 'tool_call')
  assert.equal(native.status, 'failed')
  assert.equal(native._meta?.tool_name, 'spawn_agent')
  assert.ok(details?.sessionUpdate === 'tool_call')
  assert.equal(details.kind, 'other')
  assert.equal(details._meta?.tool_name, undefined)
  assert.match(JSON.stringify(details.content), /Language server failed/)
  assert.ok(JSON.stringify(details).length < 1500)
  assert.deepEqual(details.locations, [])
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'acp:subagents',
      data: {
        id: 'failed',
        status: 'running',
        startedAt: 10000
      }
    }
  })
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'subagents:record',
      data: {
        id: 'failed',
        status: 'completed',
        startedAt: 10000,
        completedAt: 12000
      }
    }
  })
  await flush()
  const finalNative = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'pi-subagent-failed')
    .at(-1)
  assert.ok(finalNative?.sessionUpdate === 'tool_call_update')
  assert.equal(finalNative.status, 'completed')
  const resumedDetails = conn.updates
    .map(u => u.update)
    .filter(u => u.sessionUpdate === 'tool_call_update' && u.toolCallId === 'pi-agent-output-failed')
    .at(-1)
  assert.ok(resumedDetails?.sessionUpdate === 'tool_call_update')
  assert.equal(resumedDetails.toolCallId, 'pi-agent-output-failed')
  assert.match(resumedDetails.title ?? '', /Output unavailable/)
  assert.ok(!JSON.stringify(resumedDetails).includes('Language server failed'), 'a new run clears stale errors')
  session.dispose()
})
