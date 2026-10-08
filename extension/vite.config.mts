import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Bundle the playwriter package version into the extension so it can report
// which playwriter version it was built against. CLI/MCP use this to warn
// when the extension is outdated.
const playwriterPkg = JSON.parse(readFileSync(resolve(__dirname, '../playwriter/package.json'), 'utf-8'))

// Where the build id goes in background.js until the `build-id` plugin below knows it (the id
// hashes the emitted files, so it cannot be known while they are emitted).
const BUILD_ID_PLACEHOLDER = '__PLAYWRITER_BUILD_ID_PLACEHOLDER__'

const defineEnv: Record<string, string> = {
  'process.env.PLAYWRITER_PORT': JSON.stringify(process.env.PLAYWRITER_PORT || '19988'),
  __PLAYWRITER_VERSION__: JSON.stringify(playwriterPkg.version),
  __PLAYWRITER_BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER),
  __PLAYWRITER_OPEN_WELCOME_PAGE__: JSON.stringify(process.env.PLAYWRITER_OPEN_WELCOME_PAGE !== '0'),
  // Dev live-reload: only `npm run dev` sets PLAYWRITER_DEV_RELOAD=1. The same env var gates
  // the `dev-resilient-reload` plugin below, which injects the reloader itself; this define
  // tells background.ts to leave reloading to that reloader.
  __PLAYWRITER_DEV_RELOAD__: JSON.stringify(process.env.PLAYWRITER_DEV_RELOAD === '1'),
}
if (process.env.TESTING) {
  defineEnv['import.meta.env.TESTING'] = 'true'
}

// Allow tests to build per-port extension outputs to avoid parallel run conflicts.
const outDir = process.env.PLAYWRITER_EXTENSION_DIST || 'dist'


// Dev-only: prepend the live-reload prelude and wrap the app body in try/catch.
// Done at emit time rather than in source because ES `import` is hoisted (the body
// would evaluate before any guard) and dynamic `import()` is disallowed in a
// ServiceWorkerGlobalScope — so concatenation is the only ordering that works.
function devResilientReload(): Plugin {
  return {
    name: 'dev-resilient-reload',
    apply: 'build',
    enforce: 'post',
    renderChunk(code, chunk) {
      if (process.env.PLAYWRITER_DEV_RELOAD !== '1') return null
      if (chunk.fileName !== 'background.js') return null
      // The prelude compares this build's id with its folder's build.json, like background.ts: the
      // `build-id` plugin replaces the placeholder in it too.
      const prelude = readFileSync(resolve(__dirname, 'scripts/dev-reload-prelude.js'), 'utf-8').replaceAll(
        '__PLAYWRITER_BUILD_ID__',
        JSON.stringify(BUILD_ID_PLACEHOLDER),
      )
      // Safe to wrap: the emitted SW bundle has no top-level static imports.
      return {
        code:
          prelude +
          '\ntry {\n' +
          code +
          '\n globalThis.__playwriterDevClear && globalThis.__playwriterDevClear()\n' +
          '} catch (e) { globalThis.__playwriterDevReport && globalThis.__playwriterDevReport(e) }\n',
        map: null,
      }
    },
  }
}

// The build id: the first 8 hex digits of a SHA-256 over every file of the output folder but
// build.json (relative path and content, in path order, with background.js still holding the
// placeholder). The same files give the same id, so a rebuild that changes nothing changes no id.
//
// It runs in closeBundle, after every other write of the build:
// - Vite awaits rolldown's bundle.write() (which writes the chunks and HTML, then awaits every
//   plugin's writeBundle hook, vite-plugin-static-copy's copy of icons/ and manifest.json included)
//   and only then calls bundle.close(), which runs closeBundle. In watch mode Vite calls close() on
//   each BUNDLE_END, which rolldown emits after the write.
// - No other plugin of this build writes in closeBundle (Vite's own closeBundle hooks only stop
//   workers), and the Prism download runs before `vite build` (package.json).
// It replaces the placeholder in background.js, then writes build.json, each through a temp file
// and a rename, so an extension that reads the new build.json finds the whole new build on disk.
function buildId(): Plugin {
  let outDir = ''
  return {
    name: 'build-id',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(outDir, join(entry.parentPath, entry.name)))
        .filter((file) => file !== 'build.json')
        .sort()
      const hash = createHash('sha256')
      for (const file of files) {
        hash.update(file.split(sep).join('/')).update('\0').update(readFileSync(join(outDir, file))).update('\0')
      }
      const id = hash.digest('hex').slice(0, 8)
      const background = readFileSync(join(outDir, 'background.js'), 'utf-8')
      if (!background.includes(BUILD_ID_PLACEHOLDER)) {
        throw new Error(`${join(outDir, 'background.js')} has no ${BUILD_ID_PLACEHOLDER} to put build id ${id} in`)
      }
      writeAtomically(join(outDir, 'background.js'), background.replaceAll(BUILD_ID_PLACEHOLDER, id))
      writeAtomically(join(outDir, 'build.json'), `${JSON.stringify({ id })}\n`)
    },
  }
}

function writeAtomically(file: string, content: string): void {
  writeFileSync(`${file}.tmp`, content)
  renameSync(`${file}.tmp`, file)
}

export default defineConfig({
  plugins: [devResilientReload(), buildId(),
    viteStaticCopy({
      targets: [
        {
          src: resolve(__dirname, 'icons/*'),
          dest: 'icons',
        },

        {
          src: resolve(__dirname, 'manifest.json'),
          dest: '.',
          transform: (content) => {
            const manifest = JSON.parse(content)

            // Only include tabs permission during testing
            if (process.env.TESTING) {
              if (!manifest.permissions.includes('tabs')) {
                manifest.permissions.push('tabs')
              }
            }

            // Inject key for stable extension ID in dev/test builds (not production)
            // This ensures all developers get the same extension ID: pebbngnfojnignonigcnkdilknapkgid
            if (!process.env.PRODUCTION) {
              manifest.key =
                'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwCJoq5UYhOo5x8s50pVBUHjQ8idyUHnZFDj1JspWJPe6kvM7RFIaE/y5WTAH05kuK0R7v/ipcGA4ywA5wKdPKHZzkl5xstlNPj0Ivu4CqLobU7eY5G3k3Gq7wql2pbwb/A8Nat4VLbfBjQLA6TGWd3LQOHS6M0B3AvrtEw7DLDUdGKh4SCLewCbdlDIzpXQwKOzrRPyLFBwj9eEeITy5aNwJ9r9JMNBvACVZiRCHsGI6DufU+OiIO232l/8OoNNt6kdTMyNgiqOogFApXPJwREUwZHGqjXD3s6bXiBIQtwkNyZfemHKkxj6g/fhCV2EMgTY6+ikQEY1gEJMrRVmcYQIDAQAB'
            }

            return JSON.stringify(manifest, null, 2)
          },
        },
      ],
    }),
  ],

  build: {
    outDir,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
        welcome: resolve(__dirname, 'src/welcome.html'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
  define: defineEnv,
})
