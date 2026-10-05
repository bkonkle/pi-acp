import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function session() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCapabilities: { terminal: true }
  })
  return { conn, proc }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('codemode: streaming arguments upgrade one execute card without downgrading execution', async () => {
  const { conn, proc } = session()
  const readCode = 'const file = await tools.read({path: "README.md"})'
  const code = `${readCode}\nawait tools.bash({command: "pwd"})\nawait tools.mcp__notion__fetch({id: "page"})`
  const stream = (type: string, args: unknown) =>
    proc.emit({
      type: 'message_update',
      assistantMessageEvent: { type, toolCall: { id: 'c1', name: 'codemode', arguments: args } }
    })

  stream('toolcall_start', {})
  stream('toolcall_delta', { code: readCode })
  proc.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'codemode', args: { code } })
  stream('toolcall_end', { code })
  proc.emit({ type: 'tool_execution_end', toolCallId: 'c1', isError: false, result: { content: [] } })
  await flush()

  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.toolCallId),
    ['c1', 'c1', 'c1', 'c1', 'c1']
  )
  assert.deepEqual(
    updates.map(u => u.sessionUpdate),
    ['tool_call', 'tool_call_update', 'tool_call_update', 'tool_call_update', 'tool_call_update']
  )
  assert.deepEqual(
    updates.map(u => u.status),
    ['pending', 'pending', 'in_progress', 'in_progress', 'completed']
  )
  assert.equal(updates[0].kind, 'execute')
  assert.equal(updates[0].title, 'Run JavaScript')
  assert.equal(updates[0].rawInput, null)
  assert.equal(updates[1].title, 'Read files')
  assert.equal(updates[1].rawInput, `\`\`\`javascript\n${readCode}\n\`\`\``)
  assert.equal(updates[2].title, 'Read files · Run shell commands · Run notion/fetch')
  assert.equal(updates[2].rawInput, `\`\`\`javascript\n${code}\n\`\`\``)
  assert.equal(updates[3].rawInput, updates[2].rawInput)
  assert.deepEqual(updates[4].content, [])
  assert.ok(updates.every(u => u.rawOutput === undefined && u._meta === undefined))
})

test('codemode: failed scripts keep literal output fenced and never expose result JSON', async () => {
  const { conn, proc } = session()
  const code = 'const example = "```markdown\\n# not a heading\\n```"\nawait tools.read({path: "missing.md"})'
  const output = '# partial output\n```javascript\nthrow new Error("oops")\n```\n[not a link](https://example.invalid)'
  const failedCall = {
    id: 'c1/1',
    name: 'read',
    arguments: { path: 'missing.md' },
    status: 'error',
    error: 'file not found'
  }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'codemode', args: { code } })
  proc.emit({ type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [], details: { calls: [] } } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'c1',
    partialResult: { content: [{ type: 'text', text: output }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    isError: true,
    result: {
      content: [
        { type: 'text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'text', text: output }
      ],
      details: { calls: [failedCall] }
    }
  })
  await flush()

  const updates = conn.updates.map(u => u.update as any)
  assert.equal(updates[0].rawInput, `\`\`\`\`javascript\n${code}\n\`\`\`\``)
  assert.deepEqual(updates[1].content, [], 'an empty partial must not render a JSON details blob')
  assert.deepEqual(updates[2].content, [
    { type: 'content', content: { type: 'text', text: `\`\`\`\`\n${output}\n\`\`\`\`` } }
  ])
  assert.equal(updates[3].status, 'failed')
  assert.equal(
    updates[3].content[0].content.text,
    `- ✗ \` read \` \` {"path":"missing.md"} \`\n\n\`\`\`\nfile not found\n\`\`\`\n\n\`\`\`\`\n${output}\n\`\`\`\``
  )
  assert.ok(updates.every(u => u.rawOutput === undefined))
})

test('codemode: durable deeper calls and generated images stay on the parent card', async () => {
  const { conn, proc } = session()
  const code = 'return await models.generateImages({prompt: "a trail"})'
  const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
  const ownCall = { id: 'c1/1', name: 'models.generateImages', status: 'ok' }
  const result = {
    content: [
      { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'text', text: '{"images":1,"caption":"a trail"}' },
      image
    ],
    details: { calls: [ownCall] }
  }
  proc.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'codemode', args: { code } })
  proc.emit({ type: 'tool_execution_update', toolCallId: 'c1', partialResult: { content: [image] } })
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    proc.emit({
      type,
      toolCallId: 'c1/1/1',
      parentToolCallId: 'c1/1',
      toolName: 'read',
      args: { path: 'secret' },
      partialResult: { content: [] },
      result: { content: [] },
      isError: false
    })
  }
  proc.emit({ type: 'tool_execution_end', toolCallId: 'c1', isError: false, result })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'codemode',
      isError: false,
      ...result,
      nestedCalls: {
        complete: true,
        calls: [ownCall, { id: 'c1/1/1', name: 'read', status: 'ok', arguments: { path: 'palette.json' } }]
      }
    }
  })
  await flush()

  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.toolCallId),
    ['c1', 'c1', 'c1', 'c1'],
    'nested events must not create separate cards'
  )
  assert.equal(updates[0].title, 'Generate images')
  assert.deepEqual(updates[1].content, [{ type: 'content', content: image }])
  assert.deepEqual(updates[2].content[1], { type: 'content', content: image })
  assert.deepEqual(updates[3].content[1], { type: 'content', content: image })
  assert.equal(updates[3].status, 'completed')
  assert.equal(
    updates[3].content[0].content.text,
    '- ✓ ` models.generateImages `\n\n- ✓ ` read ` ` {"path":"palette.json"} `\n\n```json\n{\n  "images": 1,\n  "caption": "a trail"\n}\n```'
  )
  assert.ok(updates.every(u => u.rawOutput === undefined))
})
