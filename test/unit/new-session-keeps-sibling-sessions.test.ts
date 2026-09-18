import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

/**
 * Regression: clients like Zed multiplex every thread of a worktree through ONE agent
 * connection/process. `session/new` must therefore never dispose sibling sessions' pi
 * subprocesses — doing so halted every other running thread in the worktree the moment
 * a new thread was started (pi exited with SIGTERM / code 143 mid-turn).
 */
class FakeSessions {
  readonly map = new Map<string, any>()

  makeSession(sessionId: string, cwd: string) {
    const session: any = {
      sessionId,
      cwd,
      setStartupInfo() {},
      sendStartupInfoIfPending() {},
      proc: {
        disposeCalls: 0,
        dispose() {
          this.disposeCalls += 1
        },
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: null }
        }
      }
    }
    return session
  }

  register(sessionId: string, cwd: string) {
    const s = this.makeSession(sessionId, cwd)
    this.map.set(sessionId, s)
    return s
  }

  async create(params: any) {
    return this.register(`new-${this.map.size + 1}`, params.cwd)
  }

  maybeGet(sessionId: string) {
    return this.map.get(sessionId)
  }

  get(sessionId: string) {
    const s = this.map.get(sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${sessionId}`)
    return s
  }
}

test('newSession keeps pre-existing sessions alive (Zed runs many threads per connection)', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-agentdir-'))

  try {
    const conn = new FakeAgentSideConnection()
    const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-keep-siblings-'))

    const sessions = new FakeSessions()
    const threadA = sessions.register('thread-a', cwd)

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any

    // Thread B starts while thread A is still running — the Zed worktree scenario.
    await agent.newSession({ cwd, mcpServers: [] } as any)

    assert.equal(threadA.proc.disposeCalls, 0, 'sibling session subprocess must not be disposed')
    assert.ok(sessions.map.has('thread-a'), 'sibling session must stay registered')
    assert.equal(sessions.map.size, 2, 'both sessions should coexist on one connection')

    // A third thread must not evict either of the first two.
    await agent.newSession({ cwd, mcpServers: [] } as any)
    assert.equal(threadA.proc.disposeCalls, 0)
    assert.equal(sessions.map.size, 3)
  } finally {
    process.env.PI_CODING_AGENT_DIR = prevAgentDir
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})
