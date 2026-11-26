import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dependencies: Record<string, string> }
const external = [...Object.keys(pkg.dependencies), /^node:/, 'electron']

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external
      }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      },
      // the editor breaks if two copies of its core load (its extensions are matched with instanceof)
      dedupe: ['@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight']
    },
    optimizeDeps: {
      // pre-bundled together at dev start: the editor's grammars load on demand, and one found later would
      // be bundled apart from the core it has to share
      include: ['codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands', '@lezer/highlight', 'mermaid']
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
