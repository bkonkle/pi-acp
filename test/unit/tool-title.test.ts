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

test('toolCallTitle: namespace proxy does not double an already-prefixed inner tool', () => {
  // Models sometimes pass the adapter's direct-registered name or a dotted
  // fully-qualified name to the namespace proxy; the server prefix must appear once.
  assert.equal(toolCallTitle('mcp__notion', { tool: 'notion_notion-fetch', args: {} }), 'notion_notion-fetch')
  assert.equal(toolCallTitle('mcp__notion', { tool: 'notion.notion-fetch', args: {} }), 'notion_notion-fetch')
  assert.equal(toolCallTitle('mcp__agent_memory', { tool: 'agent-memory_remember', args: {} }), 'agent_memory_remember')
  assert.equal(toolCallTitle('mcp__agent_memory', { tool: 'agent_memory_remember', args: {} }), 'agent_memory_remember')
  // Bare inner names are untouched (dashes are not prefix separators).
  assert.equal(toolCallTitle('mcp__notion', { tool: 'notion-fetch', args: {} }), 'notion_notion-fetch')
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

test('toolCallTitle: built-in mcp__<server>__<tool> → server/tool', () => {
  assert.equal(toolCallTitle('mcp__notion__notion_get_users', { user_id: 'self' }), 'notion/notion_get_users')
  // Pi replaces `-` with `_` in server names; the first `__` still separates server and tool.
  assert.equal(toolCallTitle('mcp__datadog_cost__list_datadog_skills', {}), 'datadog_cost/list_datadog_skills')
})

test('toolCallTitle: codemode summarizes distinct operations without treating quoted code as activity', () => {
  const code = [
    '// @options: {"timeout_ms": 60000}',
    '// tools.write({})',
    '/* tools.edit({}) */',
    'text("tools.bash({})")',
    "text('tools.web_search({})')",
    'text(`tools.fetch_content({})`)',
    'const { issues } = await tools.mcp__linear__list_issues({})',
    'await Promise.all([tools.read({path: "a"}), tools.read({path: "b"})])',
    'return issues'
  ].join('\n')
  assert.equal(toolCallTitle('codemode', { code }), 'Run linear/list_issues · Read files')
  assert.equal(toolCallTitle('codemode', { code: 'return await searchTools("notion")' }), 'Search tools')
  assert.equal(toolCallTitle('codemode', { code: 'return 42' }), 'Run JavaScript')
  assert.equal(toolCallTitle('codemode', {}), 'Run JavaScript')
})
