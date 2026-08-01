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
    // Opt-in only: PW_WEBGPU=1 npx playwright test --project=chromium-webgpu
    //
    // ?renderer=webgpu is covered by the default project above, where it resolves to the WebGL2
    // fallback backend — the path every browser without WebGPU takes. This project asks for a real
    // WebGPU device instead, and is kept OUT of the default run on purpose: headless chromium's
    // software WebGPU adapter here throws "RangeError: createBuffer failed, size … too large" on
    // every frame, so it would be permanently red for a reason that is upstream, not ours. Left in
    // the config so the flags are recorded and one env var away when the adapter improves.
    ...(process.env.PW_WEBGPU
      ? [{
          name: 'chromium-webgpu',
          grep: /Group 9/,
          use: {
            ...devices['Desktop Chrome'],
            launchOptions: {
              args: [
                '--enable-unsafe-webgpu',
                '--use-webgpu-adapter=swiftshader',
                '--enable-features=Vulkan',
                '--disable-gpu-sandbox',
                '--no-sandbox',
              ],
            },
          },
        }]
      : []),
  ],
  webServer: {
    command: 'php -S localhost:8080 -t public_html',
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
