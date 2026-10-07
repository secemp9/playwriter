// Bundles App.tsx with the workspace's React 19.2.7 (pnpm store) into `<outdir>/app.js` + a linked
// `app.js.map`, as a development build (jsxDEV, _debugStack):
//   bun test/fixtures/react-tree/build.ts <outdir>
// The playwriter package itself does not depend on react, so the plugin pins react and react-dom to
// the store copy instead of whatever an ancestor node_modules provides.
import path from 'node:path'
import fs from 'node:fs'

const outdir = process.argv[2]
if (!outdir) throw new Error('usage: bun build.ts <outdir>')

const here = import.meta.dir
const store = path.resolve(here, '../../../../node_modules/.pnpm')
const reactDomPackages = path.join(store, 'react-dom@19.2.7_react@19.2.7/node_modules')
if (!fs.existsSync(path.join(reactDomPackages, 'react-dom', 'package.json'))) {
  throw new Error(`react-dom@19.2.7 not found in the workspace pnpm store at ${reactDomPackages}; run pnpm install at the workspace root`)
}

const result = await Bun.build({
  entrypoints: [path.join(here, 'App.tsx')],
  outdir,
  naming: 'app.js',
  target: 'browser',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  define: { 'process.env.NODE_ENV': '"development"' },
  jsx: { runtime: 'automatic', development: true },
  plugins: [
    {
      name: 'pin-react-19',
      setup(build) {
        build.onResolve({ filter: /^(react|react-dom|scheduler)(\/.*)?$/ }, (args) => ({
          path: Bun.resolveSync(args.path, path.join(reactDomPackages, 'react-dom')),
        }))
      },
    },
  ],
})
if (!result.success) {
  throw new Error(`bun build failed:\n${result.logs.map((log) => String(log)).join('\n')}`)
}
