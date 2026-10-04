import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultToText: codemode lists inner calls, then output without the script header', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'text', text: '["one","two"]' }
    ],
    details: {
      calls: [
        {
          id: 'c/1',
          name: 'mcp__notion__notion_get_users',
          args: '{"user_id":"self"}',
          status: 'ok',
          durationMs: 305.4
        },
        { id: 'c/2', name: 'bash', args: '{"command":"false"}', status: 'error', durationMs: 1500, error: 'exit 1' },
        { id: 'c/?', name: 'read', args: '{"path":"a"}', status: 'running' }
      ]
    }
  })
  assert.equal(
    text,
    [
      '✓ notion/notion_get_users {"user_id":"self"} 305ms',
      '✗ bash {"command":"false"} 1.5s\n    exit 1',
      '… read {"path":"a"}',
      '',
      '["one","two"]'
    ].join('\n')
  )
})

test('toolResultToText: codemode progress with no output yet shows only the calls', () => {
  const calls = Array.from({ length: 25 }, (_, i) => ({ id: `c/${i}`, name: 'bash', args: '', status: 'ok' }))
  const lines = toolResultToText({ content: [], details: { calls } }).split('\n')
  assert.equal(lines[0], '... (5 earlier calls)')
  assert.equal(lines.length, 21)
})
