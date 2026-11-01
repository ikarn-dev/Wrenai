import { telegramStart, telegramTestContext, waitingLink } from "@tests/server/telegram/test-context";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramConnections, telegramLinkChallenges } from "@/server/db/telegram-schema";
import { linkToken } from "@/server/telegram/config";
import {
  beginTelegramLink,
  cancelTelegramLink,
  claimTelegramLink,
  confirmTelegramLink,
  readTelegramLinkState,
  unlinkTelegram,
} from "@/server/telegram/linking";

vi.mock("server-only", () => ({}));
let context: Awaited<ReturnType<typeof telegramTestContext>>;
describe("Telegram links require both bot proof and authenticated web confirmation", () => {
  beforeEach(async () => {
    context = await telegramTestContext();
  });
  afterEach(async () => {
    await context.postgres.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stores only a code hash and links only after web confirmation, with safe replay", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    expect(waiting.linkUrl).toBe(`https://t.me/WrenaiTestBot?start=link_${start.token}`);
    expect(
      await beginTelegramLink(context.db, "owner", {
        requestId: waiting.challengeId,
        expectedChallengeId: null,
      }),
    ).toEqual(waiting);
    const rows = await context.db.select().from(telegramLinkChallenges);
    expect(JSON.stringify(rows)).not.toContain(start.token);
    expect(await claimTelegramLink(context.db, start)).toBe(true);
    expect(await claimTelegramLink(context.db, start)).toBe(true);
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
    expect((await readTelegramLinkState(context.db, "owner")).kind).toBe("confirm");
    const input = { challengeId: waiting.challengeId, telegramUserId: start.telegramUserId };
    const linked = await confirmTelegramLink(context.db, "owner", input);
    expect(linked.kind).toBe("linked");
    expect(await confirmTelegramLink(context.db, "owner", input)).toEqual(linked);
    expect(await context.db.select().from(telegramConnections)).toHaveLength(1);
    expect(await context.db.select().from(telegramLinkChallenges)).toHaveLength(0);
    expect(await claimTelegramLink(context.db, start)).toBe(false);
  });

  it("does not let a second identity consume a claimed code or another owner confirm it", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    await claimTelegramLink(context.db, start);
    expect(await claimTelegramLink(context.db, { ...start, telegramUserId: "99", chatId: "99" })).toBe(false);
    await expect(
      confirmTelegramLink(context.db, "stranger", {
        challengeId: waiting.challengeId,
        telegramUserId: start.telegramUserId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      confirmTelegramLink(context.db, "owner", { challengeId: waiting.challengeId, telegramUserId: "99" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(telegramConnections)).toHaveLength(0);
  });

  it("rejects expired codes and confirmations without any cleanup job", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    await claimTelegramLink(context.db, start);
    await context.db.update(telegramLinkChallenges).set({ createdAt: 1, expiresAt: 2 });
    expect(await claimTelegramLink(context.db, start)).toBe(false);
    expect((await readTelegramLinkState(context.db, "owner")).kind).toBe("unlinked");
    await expect(
      confirmTelegramLink(context.db, "owner", {
        challengeId: waiting.challengeId,
        telegramUserId: start.telegramUserId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await waitingLink(context.db)).kind).toBe("waiting");
  });

  it("invalidates pending codes after webhook-secret rotation", async () => {
    const waiting = await waitingLink(context.db);
    const start = telegramStart(waiting.challengeId);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "t".repeat(64));
    expect(await claimTelegramLink(context.db, start)).toBe(false);
    expect((await readTelegramLinkState(context.db, "owner")).kind).toBe("unlinked");
  });

  it("renews only the expected challenge and never cancels a newer link from a stale tab", async () => {
    const first = await waitingLink(context.db);
    await expect(waitingLink(context.db)).rejects.toMatchObject({ code: "conflict" });
    const next = await beginTelegramLink(context.db, "owner", {
      requestId: crypto.randomUUID(),
      expectedChallengeId: first.challengeId,
    });
    if (next.kind !== "waiting") {
      throw new Error("Expected a replacement Telegram challenge.");
    }
    expect(await claimTelegramLink(context.db, telegramStart(first.challengeId))).toBe(false);
    expect(await cancelTelegramLink(context.db, "owner", { challengeId: first.challengeId })).toEqual(next);
    expect(await cancelTelegramLink(context.db, "stranger", { challengeId: next.challengeId })).toEqual({
      kind: "unlinked",
    });
    expect(await claimTelegramLink(context.db, telegramStart(next.challengeId))).toBe(true);
  });

  it("cannot link the same Telegram identity to two owners", async () => {
    const first = await waitingLink(context.db);
    const second = await waitingLink(context.db, "stranger");
    const firstStart = telegramStart(first.challengeId);
    const secondStart = telegramStart(second.challengeId, "stranger");
    await claimTelegramLink(context.db, firstStart);
    await claimTelegramLink(context.db, secondStart);
    await confirmTelegramLink(context.db, "owner", {
      challengeId: first.challengeId,
      telegramUserId: firstStart.telegramUserId,
    });
    await expect(
      confirmTelegramLink(context.db, "stranger", {
        challengeId: second.challengeId,
        telegramUserId: secondStart.telegramUserId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await context.db.select().from(telegramConnections)).toHaveLength(1);
  });

  it("unlinks idempotently but a stale unlink cannot remove a later connection", async () => {
    const first = await waitingLink(context.db);
    const start = telegramStart(first.challengeId);
    await claimTelegramLink(context.db, start);
    await confirmTelegramLink(context.db, "owner", {
      challengeId: first.challengeId,
      telegramUserId: start.telegramUserId,
    });
    expect(await unlinkTelegram(context.db, "owner", { linkId: first.challengeId })).toEqual({
      kind: "unlinked",
    });
    expect(await unlinkTelegram(context.db, "owner", { linkId: first.challengeId })).toEqual({
      kind: "unlinked",
    });
    const second = await waitingLink(context.db);
    await claimTelegramLink(context.db, telegramStart(second.challengeId));
    await confirmTelegramLink(context.db, "owner", {
      challengeId: second.challengeId,
      telegramUserId: start.telegramUserId,
    });
    await expect(unlinkTelegram(context.db, "owner", { linkId: first.challengeId })).rejects.toMatchObject({
      code: "conflict",
    });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect((await readTelegramLinkState(context.db, "owner")).kind).toBe("linked");
    expect(await unlinkTelegram(context.db, "owner", { linkId: second.challengeId })).toEqual({
      kind: "unavailable",
    });
  });

  it("rejects half-claimed identities in SQL and binds tokens to the authenticated owner", async () => {
    const waiting = await waitingLink(context.db);
    expect(linkToken("stranger", waiting.challengeId)).not.toBe(linkToken("owner", waiting.challengeId));
    await expect(
      context.db
        .update(telegramLinkChallenges)
        .set({ claimedAt: 1, telegramUserId: "42", firstName: "Fixture" })
        .where(eq(telegramLinkChallenges.id, waiting.challengeId)),
    ).rejects.toThrow();
  });
});
