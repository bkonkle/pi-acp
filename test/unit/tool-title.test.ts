import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolCallTitle } from '../../src/acp/tool-title.js'

test('toolCallTitle: gateway mcp with tool → bare tool name', () => {
  assert.equal(toolCallTitle('mcp', { tool: 'slack_search_public', args: { query: 'x' } }), 'slack_search_public')
})

test('toolCallTitle: gateway mcp meta-actions', () => {
  assert.equal(toolCallTitle('mcp', { search: 'find monitors' }), 'mcp search "find monitors"')
  assert.equal(toolCallTitle('mcp', { describe: 'datadog_list_monitors' }), 'mcp describe datadog_list_monitors')
  assert.equal(toolCallTitle('mcp', { connect: 'slack' }), 'mcp connect slack')
  assert.equal(toolCallTitle('mcp', { action: 'auth-start', server: 'notion' }), 'mcp auth-start')
  assert.equal(toolCallTitle('mcp', { server: 'linear' }), 'mcp list linear')
  assert.equal(toolCallTitle('mcp', {}), 'mcp')
  assert.equal(toolCallTitle('mcp', undefined), 'mcp')
})

test('toolCallTitle: namespace proxy mcp__<server> prefixes the inner tool', () => {
  assert.equal(toolCallTitle('mcp__notion', { tool: 'API-post-search', args: {} }), 'notion_API-post-search')
  assert.equal(toolCallTitle('mcp__slack', {}), 'mcp__slack')
})

test('toolCallTitle: mcpScript shows the first meaningful statement', () => {
  const code = [
    '// find open prs',
    'export const meta = {',
    "  name: 'find-prs'",
    '}',
    "const r = await tools.call('linear_list_issues')"
  ].join('\n')
  assert.equal(toolCallTitle('mcpScript', { code }), "mcpScript: const r = await tools.call('linear_list_issues')")
  assert.equal(toolCallTitle('mcpScript', {}), 'mcpScript')
})

test('toolCallTitle: long titles are truncated on one line', () => {
  const title = toolCallTitle('mcp', { tool: 'x'.repeat(120) })
  assert.ok(title.length <= 80)
  assert.ok(!title.includes('\n'))
})

test('toolCallTitle: non-mcp tools keep their name', () => {
  assert.equal(toolCallTitle('read', { path: '/tmp/x' }), 'read')
  assert.equal(toolCallTitle('bash', { command: 'ls' }), 'bash')
})
