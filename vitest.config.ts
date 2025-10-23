// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // point Vitest at your client app
  root: path.resolve(__dirname, 'client'),

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@assets': path.resolve(__dirname, 'attached_assets')
    }
  },

  test: {
    environment: 'jsdom',
    globals: true, // 👈 // gives you global `expect`, `vi`, etc.
    setupFiles: ['./src/test/setup.ts'], // 👈 load jest-dom once for all tests
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      all: true,

      // ✅ only measure what we’re actively testing
      include: [
        'src/App.tsx',
        'src/lib/utils.ts',
        'src/lib/wsUrl.ts'
        // 'src/lib/rtc-debug.ts',    // add after a few more tests
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.test.*',
        'src/main.tsx',
        'src/vite-env.d.ts',

        // defer big UI and pages for now
        'src/components/**',
        'src/pages/**',

        // heavy RTC modules (add later)
        'src/lib/webrtc-quality.ts',
        'src/lib/rtc-debug.ts'
      ],

      thresholds: {
        lines: 80,
        statements: 80,
        branches: 75,
        functions: 80
      }
    }
  }
});
