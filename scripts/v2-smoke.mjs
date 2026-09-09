// Exercises the experimental ACP v2 draft agent over stdio, the way a v2-capable client would.
// Requires `"enableV2": true` in pi-acp.json (see FORK-NOTES). Run from the repo root:
//   node scripts/v2-smoke.mjs
// Exits 0 when a prompt turn completes with an idle state_update carrying stopReason=end_turn.
import { spawn } from 'node:child_process'

const cwd = process.cwd()
const child = spawn('node', ['dist/index.js'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })

let buffer = ''
let sessionId = null
let sawRunning = false
let sawMessageChunk = false
let sawUsageUpdate = false
const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue

    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg.error) {
      console.error(`error (id ${msg.id}): ${JSON.stringify(msg.error).slice(0, 300)}`)
    }

    if (msg.id === 1) {
      const version = msg.result?.protocolVersion
      if (version !== 2) {
        console.error(`FAIL: expected protocolVersion 2, got ${version} (is "enableV2": true set in pi-acp.json?)`)
        child.kill('SIGTERM')
        process.exit(1)
      }
      console.log(`initialize: protocolVersion ${version}, agent ${msg.result?.info?.name ?? '?'}`)
      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd } })
      continue
    }

    if (msg.id === 2) {
      sessionId = msg.result?.sessionId
      const configIds = (msg.result?.configOptions ?? []).map(o => o.configId).join(', ')
      console.log(`session/new: ${sessionId} | configOptions: ${configIds || 'none'}`)
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: OK' }] }
      })
      continue
    }

    if (msg.id === 3) {
      // v2: accepted immediately; the turn completes via state_update notifications.
      console.log(`prompt accepted: ${JSON.stringify(msg.result)}`)
      continue
    }

    const update = msg.params?.update
    if (!update) continue

    if (update.sessionUpdate === 'state_update') {
      console.log(`state_update: ${update.state}${update.stopReason ? ` (${update.stopReason})` : ''}`)
      if (update.state === 'running') sawRunning = true
      if (update.state === 'idle') {
        const ok = sawRunning && sawMessageChunk && update.stopReason === 'end_turn'
        console.log(
          ok
            ? `PASS: v2 turn complete (running -> idle, end_turn${sawUsageUpdate ? ', usage_update' : ''})`
            : `FAIL: missing pieces (running=${sawRunning}, messageChunk=${sawMessageChunk}, stopReason=${update.stopReason})`
        )
        child.kill('SIGTERM')
        setTimeout(() => process.exit(ok ? 0 : 1), 200)
      }
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      sawMessageChunk = true
      process.stdout.write(`agent_message_chunk (messageId=${update.messageId}): ${update.content?.text ?? ''}`)
    } else if (update.sessionUpdate === 'usage_update') {
      sawUsageUpdate = true
      console.log(`usage_update: used=${update.used}/${update.size}${update.cost ? ` cost=${update.cost.amount} ${update.cost.currency}` : ''}`)
    } else {
      console.log(`update: ${update.sessionUpdate}`)
    }
  }
})

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 2,
    info: { name: 'pi-acp-v2-smoke', version: '0.0.0' },
    capabilities: { elicitation: { form: {} } }
  }
})

setTimeout(() => {
  console.error('TIMEOUT: no idle state_update within 120s')
  child.kill('SIGTERM')
  process.exit(1)
}, 120_000)
