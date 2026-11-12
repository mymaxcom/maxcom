import { defineConfig } from 'vitest/config';

// PIN hashing is deliberately slow (scrypt N=32768), so login-heavy tests need more than the
// 5 s default when the laptop is busy; the timeout only bounds a hung test, it never hides a failure.
export default defineConfig({
  test: {
    setupFiles: ['./test/support/noProdCloud.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
