import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function sessionFor(proc: FakePiRpcProcess) {
  return new PiAcpSession({
    sessionId: 's',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as never,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
}
class IdleProcess extends FakePiRpcProcess {
  override async getState() {
    return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
  }
}

test('immediately handled commands and intercepted inputs settle without an agent_settled event', async () => {
  const proc = new IdleProcess()
  const session = sessionFor(proc)
  const first = session.prompt('/agents')
  const second = session.prompt('handled by an input extension')
  assert.equal(await first, 'end_turn')
  assert.equal(await second, 'end_turn')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['/agents', 'handled by an input extension']
  )
})

test('acceptance is not completion for a model run; late idle probes cannot settle it', async () => {
  let resolveState!: (value: Awaited<ReturnType<IdleProcess['getState']>>) => void
  const proc = new IdleProcess()
  proc.getState = () =>
    new Promise(resolve => {
      resolveState = resolve
    }) as ReturnType<IdleProcess['getState']>
  const session = sessionFor(proc)
  let completed = false
  const turn = session.prompt('/command-that-starts-a-model').then(reason => {
    completed = true
    return reason
  })
  await flush()
  proc.emit({ type: 'agent_start' })
  resolveState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })
  await flush()
  assert.equal(completed, false)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('a delayed acknowledgement failure for an old turn cannot settle the next queued turn', async () => {
  let rejectFirst!: (error: Error) => void
  const proc = new FakePiRpcProcess()
  let calls = 0
  proc.prompt = async () => {
    if (++calls === 1)
      await new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      })
  }
  const session = sessionFor(proc)
  const first = session.prompt('first')
  const second = session.prompt('second')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  await flush()
  let completed = false
  void second.then(() => {
    completed = true
  })
  proc.emit({ type: 'agent_start' })
  rejectFirst(new Error('late RPC response'))
  await flush()
  assert.equal(completed, false)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})
