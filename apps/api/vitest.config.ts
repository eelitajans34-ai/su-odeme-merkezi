import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Testler tek bir test veritabanını paylaşır; dosyalar sırayla çalışır.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    globalSetup: ['test/global-setup.ts'],
  },
});
