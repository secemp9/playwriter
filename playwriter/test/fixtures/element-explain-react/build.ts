// Bundles ChatComposer.tsx with the workspace's React 19.2.7 (pnpm store) into
// `<outdir>/app.js` + a linked `app.js.map`.
//   bun test/fixtures/element-explain-react/build.ts <outdir>               development build (jsxDEV, _debugStack)
//   bun test/fixtures/element-explain-react/build.ts <outdir> --production  minified production build (no debug info)
// The playwriter package itself does not depend on react, so the plugin pins react and
// react-dom to the store copy instead of whatever an ancestor node_modules provides.
import path from 'node:path'
import fs from 'node:fs'

const outdir = process.argv[2]
if (!outdir) throw new Error('usage: bun build.ts <outdir> [--production]')
const production = process.argv.includes('--production')

const here = import.meta.dir
const store = path.resolve(here, '../../../../node_modules/.pnpm')
const reactDomPackages = path.join(store, 'react-dom@19.2.7_react@19.2.7/node_modules')
if (!fs.existsSync(path.join(reactDomPackages, 'react-dom', 'package.json'))) {
  throw new Error(`react-dom@19.2.7 not found in the workspace pnpm store at ${reactDomPackages}; run pnpm install at the workspace root`)
}

const result = await Bun.build({
  entrypoints: [path.join(here, 'ChatComposer.tsx')],
  outdir,
  naming: 'app.js',
  target: 'browser',
  format: 'esm',
  sourcemap: 'linked',
  minify: production,
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  jsx: { runtime: 'automatic', development: !production },
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
