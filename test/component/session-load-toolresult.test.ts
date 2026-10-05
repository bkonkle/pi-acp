import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

function fakeBashSpawn() {
  return {
    onExit: () => () => {},
    onEvent: () => () => {},
    getMessages: async () => ({
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          args: { command: 'echo hello' },
          content: [{ type: 'text', text: 'hello from bash' }],
          isError: false
        }
      ]
    }),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  } as any
}

test('PiAcpAgent: loadSession replays bash toolResult as a terminal when the client supports terminals', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => fakeBashSpawn()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({ protocolVersion: 1, clientCapabilities: { terminal: true } } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays bash toolResult as a content block when the client lacks terminals', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => fakeBashSpawn()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    // No initialize (or a client without `terminal`) → terminal-less fallback.
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.status, 'completed')
    assert.deepEqual(toolCall.content, [{ type: 'content', content: { type: 'text', text: 'hello from bash' } }])
    assert.equal(toolCall._meta, undefined)

    // Terminal-less replay is a single completed tool_call; no terminal `_meta` update follows.
    const terminalUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u?._meta?.terminal_output)
    assert.equal(terminalUpdate, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

async function replayCodemode(messages: unknown[]) {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => ({
    ...fakeBashSpawn(),
    getMessages: async () => ({ messages })
  })
  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()
    await agent.initialize({ protocolVersion: 1, clientCapabilities: { terminal: true } } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
    return conn.updates.map(u => u.update as any).filter(u => u.sessionUpdate.startsWith('tool_call'))
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

function presentation(updates: any[], id: string) {
  const card = Object.assign({}, ...updates.filter(u => u.toolCallId === id))
  return { title: card.title, kind: card.kind, status: card.status, rawInput: card.rawInput, content: card.content }
}

test('PiAcpAgent: replay restores original codemode scripts by id and matches live failed and durable cards', async () => {
  const successCode = 'const literal = "```"\nreturn await tools.mcp__notion__fetch({id: "page"})'
  const failedCode = 'await tools.read({path: "missing.md"})'
  const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
  const successCall = { id: 'success/1', name: 'mcp__notion__fetch', status: 'ok', arguments: { id: 'page' } }
  const success = {
    role: 'toolResult',
    toolCallId: 'success',
    toolName: 'codemode',
    isError: false,
    content: [
      { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'text', text: '{"title":"Trail"}' },
      image
    ],
    details: { calls: [successCall] },
    nestedCalls: {
      complete: true,
      calls: [successCall, { id: 'success/1/1', name: 'read', status: 'ok', arguments: { path: 'cache.json' } }]
    }
  }
  const failed = {
    role: 'toolResult',
    toolCallId: 'failed',
    toolName: 'codemode',
    isError: true,
    content: [
      { type: 'text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'text', text: '# partial output\n```\nnot Markdown\n```' }
    ],
    details: {
      calls: [
        { id: 'failed/1', name: 'read', status: 'error', arguments: { path: 'missing.md' }, error: 'file not found' }
      ]
    }
  }
  // Pi toolResult messages have no args. Multiple calls in one assistant message and
  // reversed result order ensure replay correlates arguments by id, not position.
  const replay = await replayCodemode([
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'success', name: 'codemode', arguments: { code: successCode } },
        { type: 'toolCall', id: 'failed', name: 'codemode', arguments: { code: failedCode } }
      ]
    },
    failed,
    success
  ])

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  for (const [result, code] of [
    [failed, failedCode],
    [success, successCode]
  ] as const) {
    proc.emit({ type: 'tool_execution_start', toolCallId: result.toolCallId, toolName: 'codemode', args: { code } })
    proc.emit({ type: 'tool_execution_end', toolCallId: result.toolCallId, isError: result.isError, result })
    proc.emit({ type: 'message_end', message: result })
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  const live = conn.updates.map(u => u.update as any)

  assert.deepEqual(
    replay.map(u => u.toolCallId),
    ['failed', 'failed', 'success', 'success']
  )
  assert.deepEqual(presentation(replay, 'success'), presentation(live, 'success'))
  assert.deepEqual(presentation(replay, 'failed'), presentation(live, 'failed'))
  assert.equal(presentation(replay, 'success').title, 'Run notion/fetch')
  assert.equal(presentation(replay, 'success').rawInput, `\`\`\`\`javascript\n${successCode}\n\`\`\`\``)
  assert.equal(presentation(replay, 'failed').title, 'Read files')
  assert.equal(presentation(replay, 'failed').status, 'failed')
  assert.ok(replay.every(u => u.rawOutput === undefined && u._meta === undefined))
})

test('PiAcpAgent: empty and legacy codemode history degrades gracefully without JSON blobs', async () => {
  const cases = [
    { id: 'empty-result', args: { code: 'return 42' }, isError: false },
    { id: 'empty-code', args: { code: '' }, isError: false },
    { id: 'missing-code', args: {}, isError: true },
    { id: 'invalid-code', args: { code: 42 }, isError: false },
    { id: 'orphan', isError: false }
  ]
  const updates = await replayCodemode([
    {
      role: 'assistant',
      content: cases
        .filter(c => 'args' in c)
        .map(c => ({ type: 'toolCall', id: c.id, name: 'codemode', arguments: c.args }))
    },
    ...cases.map(c => ({
      role: 'toolResult',
      toolCallId: c.id,
      toolName: 'codemode',
      isError: c.isError,
      content: [],
      details: { calls: [] }
    }))
  ])
  assert.equal(updates.length, cases.length * 2)
  for (const c of cases) {
    const card = presentation(updates, c.id)
    assert.deepEqual(card, {
      title: 'Run JavaScript',
      kind: 'execute',
      status: c.isError ? 'failed' : 'completed',
      rawInput: c.id === 'empty-result' ? '```javascript\nreturn 42\n```' : null,
      content: []
    })
  }
  assert.ok(updates.every(u => u.rawOutput === undefined))
})
