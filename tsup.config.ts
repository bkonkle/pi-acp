import { defineConfig } from 'tsup'

// The bundled pi extensions (src/extensions/*.ts + src/pi-extension.ts) are built as separate
// entries so the adapter can load them into spawned `pi` processes via `-e <path>` (see
// src/pi-rpc/process.ts). They must stay dependency-free (type-only imports only).
export default defineConfig({
  entry: ['src/index.ts', 'src/pi-extension.ts', 'src/extensions/todo-acp.ts', 'src/extensions/auto-title.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
})
