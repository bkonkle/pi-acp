import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('PiAcpAgent: listSessions lists pi sessions and loadSession replays history', async t => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'pi-acp.json'), JSON.stringify({ dataDir: join(root, 'acp-state') }))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        name: 'My Named Session'
      }),
      JSON.stringify({
        type: 'custom',
        id: 'child-tracking',
        parentId: 'c3d4e5f6',
        customType: 'acp:subagents',
        data: {
          id: 'tracked-child',
          toolCallId: 'launch',
          description: 'Check permissions',
          prompt: 'Check authorization',
          status: 'completed',
          result: 'Permission checks passed.',
          activityTools: [
            {
              id: 'read-auth',
              name: 'read',
              title: 'src/auth.ts',
              status: 'completed',
              output: 'Permission check found'
            }
          ]
        }
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')

    // 2) load session: mock spawn to return fake proc with getMessages
    const originalSpawn = PiRpcProcess.spawn
    const fullSubagentResult = 'A useful finding\n'.repeat(10000)

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.equal(params.sessionPath, sessionFile)

      return {
        onExit: () => () => {},
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
            {
              role: 'toolResult',
              toolName: 'Agent',
              toolCallId: 'launch',
              details: { agentId: 'tracked-child' },
              content: [{ type: 'text', text: 'Agent started in background.' }]
            },
            ...['Agent', 'get_subagent_result'].map(toolName => ({
              role: 'toolResult',
              toolName,
              toolCallId: toolName,
              content: [{ type: 'text', text: fullSubagentResult }]
            }))
          ]
        }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.text === 'Hello'))
      assert.ok(texts.some(t => t.kind === 'agent_message_chunk' && t.text === 'Hi there!'))
      const subagentTools = conn.updates
        .map(u => u.update)
        .filter(
          u =>
            (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') &&
            ['Agent', 'get_subagent_result'].includes(u.toolCallId)
        )
      assert.equal(subagentTools.length, 4)
      for (const tool of subagentTools) {
        assert.ok(JSON.stringify(tool).length < 2000, 'history replay must not restore huge tool dumps')
        assert.ok(!('rawOutput' in tool))
      }
      assert.match(JSON.stringify(subagentTools), /A useful finding/)
      assert.match(JSON.stringify(subagentTools), /Preview only/)
      assert.ok(
        !conn.updates.some(
          u =>
            (u.update.sessionUpdate === 'tool_call' || u.update.sessionUpdate === 'tool_call_update') &&
            u.update.toolCallId === 'launch'
        ),
        'tracked launch replay must not duplicate its execution card'
      )
      const child = conn.updates.find(
        u => u.update.sessionUpdate === 'tool_call' && u.update.toolCallId === 'pi-subagent-tracked-child'
      )?.update
      assert.ok(child?.sessionUpdate === 'tool_call')
      assert.match(String(child.rawInput), /Check authorization/)
      assert.match(JSON.stringify(child.content), /Permission check found/)
      assert.match(JSON.stringify(child.content), /Permission checks passed/)
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
