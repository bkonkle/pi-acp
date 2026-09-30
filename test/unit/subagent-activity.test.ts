import test from 'node:test'
import assert from 'node:assert/strict'
import { SubagentActivityCollector } from '../../src/subagent-activity.js'

test('streaming activity merges with hydrated messages without reopening or reordering tools', () => {
  const collector = new SubagentActivityCollector()
  collector.observe({ type: 'message_start', message: { role: 'user', content: 'Seed context' } })
  collector.observe({
    type: 'tool_execution_start',
    toolCallId: 'command',
    toolName: 'bash',
    args: { command: 'npm test' }
  })
  collector.observe({
    type: 'tool_execution_update',
    toolCallId: 'command',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'Running tests' }] }
  })
  assert.equal(collector.snapshot().activityTools[0].output, 'Running tests')
  collector.observe({
    type: 'tool_execution_end',
    toolCallId: 'command',
    toolName: 'bash',
    result: { details: { stdout: 'All tests passed', stderr: '' } },
    isError: false
  })
  collector.observe({
    type: 'tool_execution_start',
    toolCallId: 'live',
    toolName: 'read',
    args: { path: 'src/app.ts' }
  })
  collector.observe({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking ' } })
  collector.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'the implementation.' }
  })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Run the tests' }] },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'command', name: 'bash', arguments: { command: 'npm test' } }]
    },
    {
      role: 'toolResult',
      toolCallId: 'command',
      toolName: 'bash',
      content: [{ type: 'text', text: 'All tests passed' }]
    }
  ]
  collector.hydrate(messages)
  collector.hydrate(messages)
  const snapshot = collector.snapshot()
  assert.equal(snapshot.prompt, 'Run the tests')
  assert.equal(snapshot.workingText, 'Checking the implementation.')
  assert.deepEqual(snapshot.activityTools, [
    { id: 'command', name: 'bash', title: 'bash: npm test', status: 'completed', output: 'All tests passed' },
    { id: 'live', name: 'read', title: 'read: src/app.ts', status: 'running' }
  ])
  collector.observe({
    type: 'tool_execution_end',
    toolCallId: 'live',
    toolName: 'read',
    isError: true,
    result: { details: { private: 'not readable' } }
  })
  collector.hydrate([
    ...messages,
    { role: 'assistant', content: [{ type: 'toolCall', id: 'live', name: 'read', arguments: { path: 'src/app.ts' } }] }
  ])
  assert.equal(collector.snapshot().activityTools[1].status, 'failed')
  assert.equal(collector.snapshot().activityTools[1].output, undefined)
  snapshot.activityTools[0].status = 'running'
  assert.equal(collector.snapshot().activityTools[0].status, 'completed')
  collector.observe({ type: 'message_start', message: { role: 'assistant', content: [] } })
  collector.hydrate([...messages, { role: 'assistant', content: [{ type: 'text', text: 'Older response' }] }])
  assert.equal(collector.snapshot().workingText, undefined, 'new live reply must not restore an older hydrated reply')
  collector.observe({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      delta: 'response',
      partial: { content: [{ type: 'text', text: 'New response' }] }
    }
  })
  assert.equal(collector.snapshot().workingText, 'New response')
})

test('hydration excludes inherited tools before the latest user and retains the initial task prompt', () => {
  const collector = new SubagentActivityCollector()
  const inherited = [
    { role: 'user', content: 'Parent task' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'parent', name: 'bash', arguments: { command: 'parent command' } }]
    },
    { role: 'toolResult', toolCallId: 'parent', toolName: 'bash', content: [{ type: 'text', text: 'Parent output' }] }
  ]
  const current = [
    ...inherited,
    { role: 'user', content: 'Child task' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'child', name: 'mcp__slack', arguments: { tool: 'slack.search' } }]
    },
    {
      role: 'toolResult',
      toolCallId: 'child',
      toolName: 'mcp__slack',
      isError: true,
      content: [{ type: 'text', text: 'Permission denied' }]
    }
  ]
  collector.hydrate(current)
  collector.hydrate(current)
  assert.deepEqual(collector.snapshot().activityTools, [
    { id: 'child', name: 'mcp__slack', title: 'slack_search', status: 'failed', output: 'Permission denied' }
  ])
  collector.hydrate([...current, { role: 'user', content: 'Follow-up task' }])
  assert.equal(collector.snapshot().prompt, 'Child task')
})

test('huge readable previews are bounded without mutating inputs or exposing result details', () => {
  const collector = new SubagentActivityCollector()
  const messages = [
    { role: 'user', content: 'Task '.repeat(1000) },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'long\n'.repeat(1000) } }]
    },
    {
      role: 'toolResult',
      toolCallId: 'edit',
      toolName: 'edit',
      details: { diff: 'diff\n'.repeat(1000), secret: 'NEVER SHOW' }
    },
    {
      role: 'toolResult',
      toolCallId: 'stdout',
      toolName: 'bash',
      details: { stdout: 'x'.repeat(10000), secret: 'NEVER SHOW' }
    }
  ]
  const before = structuredClone(messages)
  collector.hydrate(messages)
  const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'work '.repeat(1000) } }
  const beforeEvent = structuredClone(event)
  collector.observe(event)
  for (const malformed of [
    null,
    [],
    1,
    {},
    { type: 'tool_execution_start', toolCallId: 123 },
    { type: 'message_update', assistantMessageEvent: null }
  ])
    collector.observe(malformed)
  const snapshot = collector.snapshot()
  assert.equal(snapshot.prompt?.length, 2000)
  assert.equal(snapshot.workingText?.length, 1200)
  assert.equal(snapshot.activityTools[0].title.length, 160)
  assert.ok(!snapshot.activityTools[0].title.includes('\n'))
  for (const tool of snapshot.activityTools) {
    assert.ok(tool.output && tool.output.length <= 320)
    assert.ok(tool.output.split('\n').length <= 4)
    assert.ok(tool.output.endsWith('…'))
    assert.ok(!tool.output.includes('NEVER SHOW'))
  }
  assert.equal(snapshot.activityTools[1].output?.length, 320)
  assert.deepEqual(messages, before)
  assert.deepEqual(event, beforeEvent)
  collector.observe({ type: 'message_start', message: { role: 'assistant', content: [] } })
  collector.observe({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(1198) + '😀end' }
  })
  assert.ok(
    !collector.snapshot().workingText?.includes('\uD83D'),
    'preview cannot leave half an emoji before its ellipsis'
  )
})

test('only eight recent tools survive repeated hydration and old completion events', () => {
  const collector = new SubagentActivityCollector()
  const messages = [
    { role: 'user', content: 'Inspect files' },
    {
      role: 'assistant',
      content: Array.from({ length: 10 }, (_, i) => ({
        type: 'toolCall',
        id: String(i),
        name: 'read',
        arguments: { path: `${i}.ts` }
      }))
    }
  ]
  collector.hydrate(messages)
  collector.observe({
    type: 'tool_execution_start',
    toolCallId: 'live',
    toolName: 'write',
    args: { path: 'result.ts' }
  })
  collector.hydrate(messages)
  collector.observe({
    type: 'tool_execution_end',
    toolCallId: '0',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'Old output' }] }
  })
  assert.deepEqual(
    collector.snapshot().activityTools.map(tool => tool.id),
    ['3', '4', '5', '6', '7', '8', '9', 'live']
  )
  assert.equal(collector.snapshot().activityTools.at(-1)?.title, 'write: result.ts')
})
