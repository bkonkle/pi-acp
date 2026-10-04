import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import acpMcp, { MCP_CONFIG_ENV } from '../../src/extensions/acp-mcp.js'
import { MCP_CONFIG_ENV as SPAWN_ENV, piEnv } from '../../src/pi-rpc/process.js'

function withConfig(config: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'acp-mcp-test-'))
  try {
    const path = join(dir, 'mcp.json')
    writeFileSync(path, JSON.stringify(config), 'utf-8')
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('acp-mcp: registers every server from PI_ACP_MCP_CONFIG and keeps going after a rejected one', () => {
  withConfig(
    {
      _generatedBy: 'pi-acp',
      mcpServers: {
        chrome: { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
        taken: { url: 'http://localhost:1/mcp' },
        docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }
      }
    },
    path => {
      const registered: Array<[string, unknown]> = []
      const pi = {
        registerMcpServer(name: string, config: Record<string, unknown>) {
          if (name === 'taken') throw new Error('registered by another extension')
          registered.push([name, config])
        }
      }
      const errors: unknown[] = []
      const original = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      try {
        acpMcp(pi, { [MCP_CONFIG_ENV]: path })
      } finally {
        console.error = original
      }
      assert.deepEqual(
        registered.map(([name]) => name),
        ['chrome', 'docs']
      )
      assert.deepEqual(registered[1][1], {
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }
      })
      assert.equal(errors.length, 1)
    }
  )
})

test('acp-mcp: does nothing without the env var, with a missing file, or on a pi without MCP', () => {
  let calls = 0
  const pi = { registerMcpServer: () => void calls++ }
  acpMcp(pi, {})
  acpMcp(pi, { [MCP_CONFIG_ENV]: join(tmpdir(), 'acp-mcp-missing', 'mcp.json') })
  assert.equal(calls, 0)

  withConfig({ mcpServers: { a: { url: 'http://localhost:1/mcp' } } }, path => {
    const original = console.error
    console.error = () => {}
    try {
      assert.doesNotThrow(() => acpMcp({}, { [MCP_CONFIG_ENV]: path }))
    } finally {
      console.error = original
    }
  })
})

test('piEnv: sets PI_ACP, passes the MCP config path, and drops an inherited one', () => {
  assert.equal(SPAWN_ENV, MCP_CONFIG_ENV)
  const withPath = piEnv({ HOME: '/h' }, '/tmp/x/mcp.json')
  assert.equal(withPath.PI_ACP, '1')
  assert.equal(withPath[MCP_CONFIG_ENV], '/tmp/x/mcp.json')
  const inherited = piEnv({ [MCP_CONFIG_ENV]: '/parent/mcp.json' })
  assert.equal(inherited[MCP_CONFIG_ENV], undefined)
})
