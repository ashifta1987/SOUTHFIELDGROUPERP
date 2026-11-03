import { defineConfig, devices } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'

// Load local-only test credentials (gitignored) into process.env.
for (const file of ['.env.test.local']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'pnpm dev --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 30_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
  ],
})
