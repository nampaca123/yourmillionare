// Vitest configuration: globals disabled per CLAUDE.md (explicit imports only).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
});
