import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://dentosim:dentosim@localhost:5432/dentosim_test",
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: "/tmp/dentosim-test-storage",
      APP_URL: "http://localhost:3000",
      STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
      WORKER_TIMEOUT_S: "300",
    },
  },
});
