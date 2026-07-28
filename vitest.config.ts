import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/js/dc-*.test.js'],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['public_html/js/**/*.js'],
      exclude: ['**/node_modules/**', '**/lib/**'],
    },
  },
})
