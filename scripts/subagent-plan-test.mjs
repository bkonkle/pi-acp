import { spawn } from 'node:child_process'

const cwd = process.cwd()
const child = spawn('node', ['dist/index.js'], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env: process.env })

let sessionId = null
let buffer = ''
let planUpdates = 0
const seenAgents = new Set()
let promptDone = false
let tailTimer = null

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg?.id === 2 && msg?.result?.sessionId && !sessionId) {
      sessionId = msg.result.sessionId
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'Use the Agent tool to spawn ONE background subagent with prompt "Reply with the single word PINEAPPLE and nothing else." Do not block on it and do not call get_subagent_result. After spawning, just say OK.' }] }
      }) + '\n')
    }

    if (msg?.id === 3) {
      promptDone = true
      // Give the background subagent a moment to emit its events, then exit.
      tailTimer = setTimeout(() => {
        console.log(`\n=== plan updates: ${planUpdates}; agents seen: ${[...seenAgents].join(', ') || 'NONE'}`)
        child.kill('SIGTERM')
        setTimeout(() => process.exit(0), 200)
      }, 8000)
    }

    const u = msg?.params?.update
    if (u?.sessionUpdate === 'plan') {
      planUpdates++
      for (const e of u.entries ?? []) {
        const key = `${e.content ?? e.title}`
        if (!seenAgents.has(key)) {
          seenAgents.add(key)
          console.log(`[plan] ${e.status ?? '?'} — ${key}`)
        }
      }
    }
  }
})

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') }
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })

setTimeout(() => { console.error('timeout'); child.kill('SIGTERM'); process.exit(1) }, 120000)
