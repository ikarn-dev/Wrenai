import { createSecretKey } from "node:crypto";
import { testDatabase } from "@tests/server/db/test-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSetup,
  createManualAgentSetup,
  readAgentSetup,
  updateAgentSetup,
} from "@/server/chat/agent-drafts";
import { chatCipher } from "@/server/chat/cipher";
import { claimChatTurn, deleteConversation, finishChatTurn } from "@/server/chat/turns";
import { activeAgentToolSchema } from "@/shared/agent-scope";
import { researchToolSchema } from "@/shared/research";

vi.mock("server-only", () => ({}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 31)));
let store: Awaited<ReturnType<typeof testDatabase>>;
const receipt = {
  model: "Qwen/Qwen3.8-27B",
  completionId: "draft-test",
  signatureKind: "provider_tee",
  verifiedAt: 1000,
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  evidenceHash: "c".repeat(64),
  evidenceJson: "{}",
} as const;
describe("saved research setup ownership", () => {
  beforeEach(async () => {
    store = await testDatabase();
  });
  afterEach(async () => {
    await store.postgres.close();
  });
  it("copies only saved owner research, is idempotent, and survives source-chat deletion until discarded", async () => {
    const input = {
      conversationId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      previousTurnId: null,
      message: "Research perps",
      includeContext: false,
    };
    const claim = await claimChatTurn(store.db, "owner", input, { cipher });
    if (claim.kind !== "claimed") {
      throw new Error("Expected claim");
    }
    await expect(
      createAgentSetup(store.db, "owner", input.conversationId, input.requestId, "perps", cipher),
    ).rejects.toMatchObject({ code: "conflict" });
    await finishChatTurn(
      store.db,
      "owner",
      input,
      claim.token,
      {
        state: "complete",
        receipt,
        reply: {
          content: "No net edge established.",
          receipt: {
            model: receipt.model,
            completionId: receipt.completionId,
            signatureKind: receipt.signatureKind,
            verifiedAt: receipt.verifiedAt,
            evidenceHash: receipt.evidenceHash,
          },
          context: null,
          historyTrimmed: false,
          research: [
            {
              tool: "perps",
              status: "partial",
              summary: "Checked sample pools",
              observedAt: 1000,
              items: [],
              sources: [],
              limitations: [],
            },
          ],
        },
      },
      cipher,
    );
    const draft = await createAgentSetup(
      store.db,
      "owner",
      input.conversationId,
      input.requestId,
      "perps",
      cipher,
    );
    expect(
      await createAgentSetup(store.db, "owner", input.conversationId, input.requestId, "perps", cipher),
    ).toEqual(draft);
    await expect(readAgentSetup(store.db, "stranger", draft.id, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(updateAgentSetup(store.db, "stranger", draft.id, null, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      createAgentSetup(store.db, "owner", input.conversationId, input.requestId, "dca", cipher),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await deleteConversation(store.db, "owner", input.conversationId);
    expect((await readAgentSetup(store.db, "owner", draft.id, cipher)).reports).toHaveLength(1);
    await updateAgentSetup(store.db, "owner", draft.id, "Changed instructions", cipher);
    expect((await readAgentSetup(store.db, "owner", draft.id, cipher)).brief).toBe("Changed instructions");
    await updateAgentSetup(store.db, "owner", draft.id, null, cipher);
    await expect(readAgentSetup(store.db, "owner", draft.id, cipher)).rejects.toMatchObject({
      code: "not_found",
    });
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
