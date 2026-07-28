import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000, // 60 seconds for Chrome startup
    hookTimeout: 30000,
    exclude: ['dist', 'dist/**/*', '**/node_modules/**', 'test/fixtures/**'],
    setupFiles: ['./vitest.setup.ts'],

    env: {
      PLAYWRITER_NODE_ENV: 'development',
    },
  },
})
