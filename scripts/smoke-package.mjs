import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'pi-acp-package-smoke-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const require = createRequire(import.meta.url)

async function loadPiSdk() {
  const names = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']
  for (const name of names) {
    let path
    try {
      path = require.resolve(name)
    } catch {
      continue
    }
    return import(pathToFileURL(path).href)
  }
  const modules = execFileSync(npm, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
  for (const name of names) {
    const path = join(modules, name, 'dist/index.js')
    if (existsSync(path)) return import(pathToFileURL(path).href)
  }
  throw new Error('Install Pi locally or globally to run the package-loading smoke.')
}

try {
  // Exercise the tarball consumers actually receive, not imports from the development checkout.
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
  )
  execFileSync('tar', ['-xzf', join(root, packed[0].filename), '-C', root])
  const packageRoot = join(root, 'package')
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const { DefaultResourceLoader, SettingsManager } = await loadPiSdk()
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [packageRoot]
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  assert.deepEqual(loaded.errors, [], 'published source extension and its runtime helpers must load in Pi')
  assert.equal(loaded.extensions.length, manifest.pi.extensions.length)
  for (const entry of manifest.pi.extensions) {
    assert.ok(
      loaded.extensions.some(extension => extension.path === join(packageRoot, entry)),
      `Pi did not load ${entry}`
    )
  }
  console.log('Packed-package smoke passed: every advertised Pi extension loads through the real resource loader.')
} finally {
  rmSync(root, { recursive: true, force: true })
}
