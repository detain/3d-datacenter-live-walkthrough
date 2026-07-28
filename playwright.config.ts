import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    // Enable software WebGL (SwiftShader) for headless testing
    launchOptions: {
      args: [
        '--use-gl=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blacklist',
        '--disable-gpu-sandbox',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Additional Chromium-specific flags for WebGL in CI
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--enable-webgl',
            '--ignore-gpu-blacklist',
            '--disable-gpu-sandbox',
            '--no-sandbox',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'php -S localhost:8080 -t public_html',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
