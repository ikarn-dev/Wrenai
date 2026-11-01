import { createSecretKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chatCipher } from "@/server/chat/cipher";
import { openMessage, sealMessage } from "@/server/chat/message-record";
import type { ChatInput } from "@/shared/chat";

vi.mock("server-only", () => ({}));
const cipher = chatCipher(createSecretKey(Buffer.alloc(32, 41)));
const input: ChatInput = {
  conversationId: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  previousTurnId: null,
  message: "Find arbitrage",
  includeContext: true,
  tool: "arbitrage",
};

describe("encrypted message tool selection", () => {
  it("round-trips tool metadata without putting it or the message into plaintext storage", () => {
    const sealed = sealMessage(cipher, "owner", input);
    expect(sealed).not.toContain(input.message);
    expect(sealed).not.toContain("arbitrage");
    expect(openMessage(cipher, "owner", input.conversationId, input.requestId, sealed)).toEqual({
      message: input.message,
      tool: "arbitrage",
    });
  });
  it("reads legacy messages without interpreting their text as an envelope", () => {
    const text = 'm1:{"message":"literal user text","tool":"perps"}';
    const legacy = cipher.seal("owner", input.conversationId, `${input.requestId}:user`, text);
    expect(openMessage(cipher, "owner", input.conversationId, input.requestId, legacy)).toEqual({
      message: text,
    });
    const automatic = sealMessage(cipher, "owner", { ...input, tool: null });
    expect(cipher.open("owner", input.conversationId, `${input.requestId}:user`, automatic)).toBe(
      input.message,
    );
  });
  it("authenticates the owner, turn and envelope version without a downgrade fallback", () => {
    const sealed = sealMessage(cipher, "owner", input);
    expect(() => openMessage(cipher, "stranger", input.conversationId, input.requestId, sealed)).toThrow();
    expect(() => openMessage(cipher, "owner", input.conversationId, crypto.randomUUID(), sealed)).toThrow();
    expect(() =>
      openMessage(cipher, "owner", input.conversationId, input.requestId, sealed.slice(3)),
    ).toThrow();
  });
});
