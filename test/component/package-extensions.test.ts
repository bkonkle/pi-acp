import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('the npm artifact can import every advertised Pi extension and its runtime helpers', async t => {
  const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-packed-extensions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
  ) as { filename: string }[]
  execFileSync('tar', ['-xzf', join(root, packed[0].filename), '-C', root])
  const packageRoot = join(root, 'package')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    pi: { extensions: string[] }
  }
  for (const entry of manifest.pi.extensions) {
    const extension = await import(pathToFileURL(join(packageRoot, entry)).href)
    assert.equal(typeof extension.default, 'function', `Cannot load packaged extension ${entry}`)
  }
})
