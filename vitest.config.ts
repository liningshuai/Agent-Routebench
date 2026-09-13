import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    root: import.meta.dirname,
    // Two suites build real artefacts inside a hook (the Desktop bundle and
    // the Rust host). The default 10s hook timeout is far below the real cost
    // of a cold build, so an honest build was reported as "Hook timed out in
    // 10000ms" whenever the build fingerprint changed. Individual tests keep
    // their own explicit timeouts; this only stops hooks from being cut short.
    hookTimeout: 20 * 60 * 1000,
  },
});
