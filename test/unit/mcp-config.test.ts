import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import registerAcpMcp, { MCP_CONFIG_ENV } from '../../src/extensions/acp-mcp.js'
import {
  translateMcpServers,
  writeMcpConfig,
  loadMcpPolicy,
  cleanupStaleGeneratedConfig,
  toPiServerName
} from '../../src/acp/mcp-config.js'

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
}

test('translateMcpServers: stdio server → command/args/env', () => {
  const servers: McpServer[] = [
    { name: 'chrome', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: [{ name: 'KEY', value: 'v' }] }
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, [])
  assert.deepEqual(config.mcpServers.chrome, {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.6.0'],
    env: { KEY: 'v' }
  })
  assert.equal(config._generatedBy, 'pi-acp')
})

test('translateMcpServers: http server → url/headers', () => {
  const servers: McpServer[] = [
    {
      type: 'http',
      name: 'remote',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }]
    }
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, [])
  assert.deepEqual(config.mcpServers.remote, {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer x' }
  })
})

test('translateMcpServers: sse/acp are skipped, not translated', () => {
  const servers: McpServer[] = [
    { type: 'sse', name: 'streamy', url: 'https://example.com/sse', headers: [] } as unknown as McpServer
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, ['streamy'])
  assert.deepEqual(config.mcpServers, {})
})

test('writeMcpConfig: native bridge round-trips a private session overlay and cleanup removes it', () => {
  const cwd = tmpCwd()
  try {
    const servers: McpServer[] = [
      { name: 'Chrome DevTools', command: 'npx', args: [], env: [] },
      { type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [] }
    ]
    const res = writeMcpConfig(servers, { auth: { remote: { bearerTokenEnv: 'REMOTE_TOKEN' } } })
    assert.ok(res.handle)
    const path = res.handle!.path
    // Not in the project's pi config namespace — a temp file.
    assert.equal(path.includes(join(cwd, '.pi')), false)
    assert.ok(existsSync(path))
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    const registrations: Record<string, unknown> = {}
    registerAcpMcp(
      {
        registerMcpServer: (name, config) => {
          registrations[name] = config
        }
      },
      { [MCP_CONFIG_ENV]: path }
    )
    assert.deepEqual(registrations, parsed.mcpServers)
    assert.ok(registrations['Chrome-DevTools'])
    assert.equal(parsed.mcpServers.remote.headers.Authorization, 'Bearer ${REMOTE_TOKEN}')
    // We never touch the project's .pi/mcp.json.
    assert.equal(existsSync(join(cwd, '.pi', 'mcp.json')), false)
    // Owner-only perms — the file can carry client-provided header/env secrets.
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    }

    res.handle!.cleanup()
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(dirname(path)), false)
    res.handle!.cleanup() // Session shutdown can be requested more than once.
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeMcpConfig: no servers → nothing written', () => {
  const res = writeMcpConfig([])
  assert.equal(res.handle, null)
})

test('cleanupStaleGeneratedConfig: removes a pi-acp-generated <cwd>/.pi/mcp.json, leaves a hand-authored one', () => {
  const cwd = tmpCwd()
  try {
    const dir = join(cwd, '.pi')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')

    // pi-acp-generated (has the marker) → removed.
    writeFileSync(path, JSON.stringify({ mcpServers: {}, _generatedBy: 'pi-acp' }), 'utf-8')
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(existsSync(path), false)

    // hand-authored (no marker) → left untouched.
    const handwritten = JSON.stringify({ mcpServers: { mine: { command: 'x', args: [] } } })
    writeFileSync(path, handwritten, 'utf-8')
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(readFileSync(path, 'utf-8'), handwritten)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('policy: exclude → server is not generated (deferred to user config); others still generated', () => {
  const servers: McpServer[] = [
    {
      type: 'http',
      name: 'mcp-combiner',
      url: 'http://127.0.0.1:9741/mcp/tok',
      headers: [{ name: 'X-Session', value: 'tok' }]
    },
    { type: 'http', name: 'other', url: 'http://localhost:1/mcp', headers: [] }
  ]
  const { config, preserved } = translateMcpServers(servers, { exclude: ['mcp-combiner'] })
  assert.deepEqual(preserved, ['mcp-combiner'])
  assert.equal(config.mcpServers['mcp-combiner'], undefined) // not written — user's own entry stands
  assert.ok(config.mcpServers.other) // others still generated
})

test('policy: generate allowlist writes only named servers (rest preserved); case-insensitive', () => {
  const servers: McpServer[] = [
    { type: 'http', name: 'Keep', url: 'http://localhost:1/mcp', headers: [] },
    { type: 'http', name: 'Drop', url: 'http://localhost:2/mcp', headers: [] }
  ]
  const { config, preserved } = translateMcpServers(servers, { generate: ['keep'] })
  assert.ok(config.mcpServers.Keep)
  assert.equal(config.mcpServers.Drop, undefined)
  assert.deepEqual(preserved, ['Drop'])
})

test('policy: generate:false writes nothing (all preserved)', () => {
  const servers: McpServer[] = [{ type: 'http', name: 'a', url: 'http://localhost:1/mcp', headers: [] }]
  const { config, preserved } = translateMcpServers(servers, { generate: false })
  assert.deepEqual(config.mcpServers, {})
  assert.deepEqual(preserved, ['a'])
})

test('policy.auth: bearerTokenEnv → writes a ${VAR} Authorization header (no secret on disk)', () => {
  const servers: McpServer[] = [
    { type: 'http', name: 'foo', url: 'http://localhost:1/mcp', headers: [{ name: 'X-Session', value: 'tok' }] }
  ]
  const { config } = translateMcpServers(servers, {
    auth: { foo: { bearerTokenEnv: 'FOO_TOKEN', headers: { 'X-Extra': 'e' } } }
  })
  const entry = config.mcpServers.foo as { url: string; headers: Record<string, string> }
  assert.equal(entry.headers['Authorization'], 'Bearer ${FOO_TOKEN}')
  assert.equal(entry.headers['X-Extra'], 'e')
  assert.equal(entry.headers['X-Session'], 'tok') // client header preserved
})

test('loadMcpPolicy: parses generate/exclude/auth; missing file → {}', () => {
  const dir = tmpCwd()
  try {
    const p = join(dir, 'policy.json')
    writeFileSync(
      p,
      JSON.stringify({
        generate: ['keep'],
        exclude: ['mcp-combiner'],
        auth: { foo: { bearerTokenEnv: 'T', headers: { A: 'b' } } }
      })
    )
    const loaded = loadMcpPolicy(p)
    assert.deepEqual(loaded.generate, ['keep'])
    assert.deepEqual(loaded.exclude, ['mcp-combiner'])
    assert.equal(loaded.auth?.foo.bearerTokenEnv, 'T')
    assert.deepEqual(loaded.auth?.foo.headers, { A: 'b' })

    const star = join(dir, 'star.json')
    writeFileSync(star, JSON.stringify({ generate: '*' }))
    assert.equal(loadMcpPolicy(star).generate, '*')

    assert.deepEqual(loadMcpPolicy(join(dir, 'nope.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('translateMcpServers: client display names become pi-safe server names without replacing a colliding server', () => {
  const servers: McpServer[] = [
    { name: 'Chrome DevTools', command: 'npx', args: [], env: [] },
    { type: 'http', name: 'Chrome-DevTools', url: 'http://localhost:1/mcp', headers: [] },
    { type: 'http', name: 'Chrome_DevTools', url: 'http://localhost:2/mcp', headers: [] },
    { type: 'http', name: '  !!! ', url: 'http://localhost:3/mcp', headers: [] },
    { name: '__proto__', command: 'custom-server', args: [], env: [] }
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(Object.keys(config.mcpServers), ['Chrome-DevTools', '__proto__'])
  assert.deepEqual(config.mcpServers['Chrome-DevTools'], { command: 'npx', args: [] })
  assert.deepEqual(config.mcpServers.__proto__, { command: 'custom-server', args: [] })
  assert.deepEqual(skipped, ['Chrome-DevTools', 'Chrome_DevTools', '!!!'])
  assert.equal(toPiServerName('my.server/v2'), 'my-server-v2')
})
