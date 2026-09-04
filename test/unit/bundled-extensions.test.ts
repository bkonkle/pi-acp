import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledExtensionArgs } from '../../src/pi-rpc/process.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', '..', 'src')

test('bundledExtensionArgs: resolves all three bundled extensions from the source tree', () => {
  const args = bundledExtensionArgs(join(srcRoot, 'pi-rpc', 'process.ts'))
  // tsx dev layout: import.meta.url points at src/pi-rpc/process.ts
  const expected = [
    join(srcRoot, 'pi-extension.ts'),
    join(srcRoot, 'extensions', 'todo-acp.ts'),
    join(srcRoot, 'extensions', 'auto-title.ts')
  ]
  assert.deepEqual(
    args,
    expected.flatMap(p => ['-e', p])
  )
  for (const p of expected) assert.ok(existsSync(p), `${p} should exist`)
})

test('bundledExtensionArgs: resolves built .js files from a dist-style layout', () => {
  // Simulate the compiled layout: dist/index.js with dist/extensions/*.js
  const distRoot = join(srcRoot, '..', 'dist')
  if (!existsSync(join(distRoot, 'extensions'))) return // not built yet
  const args = bundledExtensionArgs(join(distRoot, 'index.js'))
  const expected = [
    join(distRoot, 'pi-extension.js'),
    join(distRoot, 'extensions', 'todo-acp.js'),
    join(distRoot, 'extensions', 'auto-title.js')
  ]
  assert.deepEqual(
    args,
    expected.flatMap(p => ['-e', p])
  )
})

test('bundledExtensionArgs: skips extensions that do not exist for the given layout', () => {
  // A dirname (after lexical `..` normalization) with none of the candidate files
  // yields no -e args. Use a temp dir so `..` can't climb back into src/.
  const args = bundledExtensionArgs(join(tmpdir(), 'pi-acp-test-nonexistent-sub', 'index.js'))
  assert.deepEqual(args, [])
})
