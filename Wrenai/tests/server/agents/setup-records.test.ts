import { createSecretKey } from "node:crypto";
import { createManualAgentSetup, readAgentSetup, updateAgentSetup } from "@tests/server/agents/setup-fixture";
import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCipher } from "@/server/chat/cipher";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { researchToolSchema } from "@/shared/research";

vi.mock("server-only", () => ({}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 31)));
let store: Awaited<ReturnType<typeof testDatabase>>;
describe("agent setup records", () => {
  beforeEach(async () => {
    store = await testDatabase();
  });
  afterEach(async () => {
    await store.postgres.close();
  });
  it("creates and reviews every catalog type without a synthetic chat or execution authority", async () => {
    for (const value of activeAgentToolSchema.options) {
      const tool = researchToolSchema.parse(value),
        id = crypto.randomUUID();
      const draft = await createManualAgentSetup(
        store.db,
        "owner",
        id,
        tool,
        ["User-selected assets", "User-selected conditions", "User-selected limits"],
        "",
        cipher,
      );
      expect(draft.tool).toBe(tool);
      expect(draft.reviewState).toBe("draft");
      expect(draft.reports).toHaveLength(0);
      expect(
        await createManualAgentSetup(
          store.db,
          "owner",
          id,
          tool,
          ["User-selected assets", "User-selected conditions", "User-selected limits"],
          "",
          cipher,
        ),
      ).toEqual(draft);
      await updateAgentSetup(store.db, "owner", id, draft.brief, cipher, true);
      expect((await readAgentSetup(store.db, "owner", id, cipher)).reviewState).toBe("reviewed");
      await updateAgentSetup(store.db, "owner", id, "Changed instructions", cipher);
      expect((await readAgentSetup(store.db, "owner", id, cipher)).reviewState).toBe("draft");
      await expect(
        createManualAgentSetup(store.db, "stranger", id, tool, ["a", "b", "c"], "", cipher),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect((await store.postgres.query("SELECT id FROM chat_conversations")).rows).toHaveLength(0);
    expect((await store.postgres.query("SELECT id FROM agents")).rows).toHaveLength(0);
  });
});
