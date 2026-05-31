import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [],
    passWithNoTests: true,
    projects: [
      'packages/shared',
      'packages/server',
      'packages/agent',
      'packages/web',
    ],
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    include: ['packages/*/src/**'],
  },
});
