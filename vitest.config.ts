import { defineConfig } from 'vitest/config';

// Backend-local vitest config. The backend lives as a subdir of the plugin repo, so
// without this file vitest would discover the plugin's vitest.config.ts (which includes
// only src/__tests__/**/*.test.ts) and find no backend tests. Backend tests live in
// __tests__/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
});
