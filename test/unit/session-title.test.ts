import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSessionTitleEntry } from '../../src/acp/session-title.js'

test('parseSessionTitleEntry: extracts a trimmed title', () => {
  assert.equal(parseSessionTitleEntry({ title: '  Fix auth redirect  ' }), 'Fix auth redirect')
})

test('parseSessionTitleEntry: accepts manual-source payloads with a title', () => {
  assert.equal(parseSessionTitleEntry({ title: 'Manual name', source: 'manual' }), 'Manual name')
})

test('parseSessionTitleEntry: returns null for manual entries without a title', () => {
  assert.equal(parseSessionTitleEntry({ source: 'manual' }), null)
  assert.equal(parseSessionTitleEntry({ title: undefined, source: 'manual' }), null)
})

test('parseSessionTitleEntry: returns null for empty/whitespace titles', () => {
  assert.equal(parseSessionTitleEntry({ title: '' }), null)
  assert.equal(parseSessionTitleEntry({ title: '   ' }), null)
})

test('parseSessionTitleEntry: returns null for malformed payloads', () => {
  assert.equal(parseSessionTitleEntry(null), null)
  assert.equal(parseSessionTitleEntry(undefined), null)
  assert.equal(parseSessionTitleEntry('Fix auth redirect'), null)
  assert.equal(parseSessionTitleEntry(42), null)
  assert.equal(parseSessionTitleEntry({}), null)
})
