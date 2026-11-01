import { describe, expect, it } from "vitest";
import { testLayoutIssue } from "../../scripts/check-tests";

describe("test directory enforcement", () => {
  it.each([
    "Wrenai/src/server/chat/prompt.test.ts",
    "Wrenai/src/components/chat/message.spec.tsx",
    "Wrenai/src/server/db/test-database.ts",
    "Wrenai/src/server/execution/defi-test-context.ts",
    "Wrenai/src/server/execution/oneclick-intent.fixture.json",
    "Wrenai/src/shared/__tests__/money.ts",
    "Wrenai/scripts/tests/task.ts",
    "test/account.test.ts",
    "LandingPage/src/example.test.js",
    "Wrenai/tests/../src/escape.test.ts",
  ])("rejects test material outside the dedicated directory: %s", (file) => {
    expect(testLayoutIssue(file)).not.toBeNull();
  });

  it.each([
    "Wrenai/tests/server/chat/prompt.test.ts",
    "Wrenai/tests/server/db/test-database.ts",
    "Wrenai/tests/server/execution/oneclick-intent.fixture.json",
    "Wrenai/tests/server/__snapshots__/reply.snap",
  ])("accepts organized test material: %s", (file) => {
    expect(testLayoutIssue(file, 'import { it } from "vitest";')).toBeNull();
  });

  it.each([
    'import { it } from "vitest";',
    'const tests = await import("node:test");',
    'const tests = require("@playwright/test");',
    'import { PGlite } from "@electric-sql/pglite";',
    'import type { Mock } from "vitest";',
    'import { fixture } from "@tests/server/fixture";',
    'import { fixture } from "../tests/server/fixture";',
  ])("rejects test code hidden under an ordinary source filename: %s", (content) => {
    expect(testLayoutIssue("Wrenai/src/module.ts", content)).not.toBeNull();
  });

  it("allows real application modules, tool configs and literal code examples", () => {
    expect(testLayoutIssue("Docs/wrenai-spec.md")).toBeNull();
    expect(testLayoutIssue("Docs/test-guidance.md")).toBeNull();
    expect(testLayoutIssue("Wrenai/public/api-spec.json")).toBeNull();
    expect(
      testLayoutIssue("Wrenai/src/server/ai/attestation-receipt.ts", 'import { z } from "zod";'),
    ).toBeNull();
    expect(
      testLayoutIssue("Wrenai/vitest.config.ts", 'import { defineConfig } from "vitest/config";'),
    ).toBeNull();
    expect(
      testLayoutIssue("Wrenai/src/example.ts", 'const example = `import { it } from "vitest";`;'),
    ).toBeNull();
  });
});
