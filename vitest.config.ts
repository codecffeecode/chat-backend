import { defineConfig } from "vitest/config";

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      FIREBASE_PROJECT_ID: "demo-chat-backend",
      FIREBASE_CLIENT_EMAIL: "",
      FIREBASE_PRIVATE_KEY: "",
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
      FIRESTORE_COLLECTION_PREFIX: `test_${runId}_`,
    },
  },
});
