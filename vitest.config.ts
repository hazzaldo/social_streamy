// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
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
    environmentOptions: {
      jsdom: { url: 'http://localhost' }
    },
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      all: true,
      include: ['src/App.tsx', 'src/lib/utils.ts', 'src/lib/wsUrl.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.*',
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/components/**',
        'src/pages/**',
        'src/lib/webrtc-quality.ts',
        'src/lib/rtc-debug.ts'
      ],
      thresholds: { lines: 80, statements: 80, branches: 75, functions: 80 }
    }
  }
});
