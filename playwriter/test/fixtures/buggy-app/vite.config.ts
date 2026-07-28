import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Fixture app for trace/debug e2e tests.
// Source maps are REQUIRED so a bundle position maps back to author source.
export default defineConfig({
  plugins: [react()],
  build: {
    // Emit dist/assets/*.js alongside *.js.map so a bundle position
    // can be mapped back to the original TypeScript source.
    sourcemap: true,
    // Keep output readable-ish; do not inline the maps.
    minify: 'esbuild',
  },
  server: {
    port: 4317,
  },
  preview: {
    port: 4318,
    strictPort: true,
  },
})
