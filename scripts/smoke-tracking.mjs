// Real Pi RPC + ACP smoke with a local execution fixture; no model or credentials required.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  statSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = mkdtempSync(join(tmpdir(), 'pi-acp-tracking-smoke-'))
const agentDir = join(root, 'agent')
const cwd = join(root, 'workspace')
mkdirSync(join(agentDir, 'extensions'), { recursive: true })
mkdirSync(cwd)
writeFileSync(join(cwd, 'TODO.md'), '- [ ] Human document\n')
writeFileSync(join(agentDir, 'settings.json'), '{}')
writeFileSync(join(agentDir, 'extensions', 'pi-acp.json'), JSON.stringify({ dataDir: join(root, 'acp') }))
// Satisfy the adapter's configured-model gate; commands below never invoke a provider.
writeFileSync(
  join(agentDir, 'auth.json'),
  JSON.stringify({ openai: { type: 'api_key', key: 'offline-smoke-not-a-credential' } }),
  { mode: 0o600 }
)
writeFileSync(
  join(agentDir, 'extensions', 'tracking-smoke.ts'),
  `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi) {
  const records = new Map();
  globalThis[Symbol.for('pi-subagents:manager')] = { getRecord: id => records.get(id) };
  pi.registerCommand('tracking-smoke-start', { description: 'Offline smoke fixture', handler: (_args, ctx) => {
    const outputFile = join(ctx.cwd, 'child.output');
    writeFileSync(outputFile, 'Live child output\\n' + 'Full transcript content\\n'.repeat(5000));
    records.set('smoke-child', {id: 'smoke-child', description: 'Offline smoke child', status: 'running',
      rootSessionId: ctx.sessionManager.getSessionId(), startedAt: Date.now(), outputFile, toolUses: 1});
    pi.events.emit('subagents:started', {id: 'smoke-child'});
  }});
  pi.registerCommand('tracking-smoke-abort', { description: 'Silent queued cancellation fixture', handler: () => {
    Object.assign(records.get('smoke-child'), {status: 'aborted', error: 'Offline cancellation', completedAt: Date.now()});
  }});
}
`
)

const pending = new Map()
const messages = []
const waiters = new Set()
let stderr = ''
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TODO_DIR: join(root, 'plans')
  }
})
const lines = createInterface({ input: child.stdout })
child.stderr.on('data', chunk => {
  stderr += chunk.toString()
})
lines.on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  messages.push(message)
  if (pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(timer)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
  for (const waiter of waiters) {
    if (waiter.predicate(message)) {
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  }
})
let requestId = 0
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId
    const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 15_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function waitFor(predicate) {
  const found = messages.find(predicate)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Expected tracking update timed out\n${stderr}`)), 15_000)
    waiters.add({ predicate, resolve, timer })
  })
}
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await request('session/new', { cwd, mcpServers: [] })
  const plan = join(root, 'plans', sessionId, 'TODO.md')
  assert.ok(existsSync(plan), 'real Pi startup creates the external per-session plan')
  assert.equal(statSync(plan).mode & 0o777, 0o600)
  const prompt = text => request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  assert.equal(
    (await prompt('/tracking-smoke-start')).stopReason,
    'end_turn',
    'handled commands finish without model events'
  )
  const live = await waitFor(
    m => m.params?.update?.toolCallId === 'pi-subagent-smoke-child' && m.params.update.status === 'in_progress'
  )
  assert.equal(live.params.update._meta.tool_name, 'spawn_agent', 'Zed native renderer metadata')
  assert.ok(JSON.stringify(live.params.update).length < 2000, 'status rows stay small')
  assert.ok(!JSON.stringify(live.params.update).includes('Full transcript content'))
  const artifact = await waitFor(m => m.params?.update?.toolCallId === 'pi-agent-output-smoke-child')
  assert.equal(artifact.params.update.kind, 'read')
  assert.equal(artifact.params.update._meta.tool_name, undefined)
  assert.equal(realpathSync(artifact.params.update.locations[0].path), realpathSync(join(cwd, 'child.output')))
  const fullOutput = readFileSync(join(cwd, 'child.output'), 'utf8')
  assert.ok(fullOutput.length > 32_000, 'full transcript is not capped at the old preview limit')
  assert.match(fullOutput, /Live child output/)
  assert.equal((await prompt('/tracking-smoke-abort')).stopReason, 'end_turn')
  const terminal = await waitFor(
    m => m.params?.update?.toolCallId === 'pi-subagent-smoke-child' && m.params.update.status === 'failed'
  )
  assert.match(JSON.stringify(terminal.params.update.content), /Offline cancellation/)
  assert.ok(!existsSync(join(cwd, '.pi')), 'no generated task files enter the workspace')
  assert.equal(readFileSync(join(cwd, 'TODO.md'), 'utf8'), '- [ ] Human document\n')
  console.log(
    'Real Pi RPC smoke passed: external plan, handled command completion, native status row, full output file, silent cancellation.'
  )
} finally {
  for (const item of pending.values()) clearTimeout(item.timer)
  for (const item of waiters) clearTimeout(item.timer)
  lines.close()
  child.kill('SIGTERM')
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', resolve)
  })
  rmSync(root, { recursive: true, force: true })
}
