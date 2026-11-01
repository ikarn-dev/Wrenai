import "server-only";
import { and, eq } from "drizzle-orm";
import { AgentError } from "@/server/agents/errors";
import { auditAgent } from "@/server/agents/records";
import type { AppDatabase } from "@/server/db/client";
import { telegramConnections, telegramLinkChallenges } from "@/server/db/telegram-schema";
import { userTransaction } from "@/server/db/user-transaction";
import { databaseTime, executionHash } from "@/server/execution/records";
import {
  beginTelegramLinkSchema,
  cancelTelegramLinkSchema,
  confirmTelegramLinkSchema,
  type TelegramLinkState,
  unlinkTelegramSchema,
} from "@/shared/telegram";
import { linkToken, telegramBotUsername, telegramConfig } from "./config";
import type { TelegramStart } from "./update";

const LINK_TTL_MS = 5 * 60_000;
type Challenge = typeof telegramLinkChallenges.$inferSelect;

function validChallenge(challenge: Challenge, now: number): boolean {
  return (
    challenge.expiresAt > now &&
    telegramConfig() !== null &&
    challenge.tokenHash === executionHash(linkToken(challenge.userId, challenge.id))
  );
}
function linkedState(row: typeof telegramConnections.$inferSelect): TelegramLinkState {
  return {
    kind: "linked",
    linkId: row.linkId,
    linkedAt: row.linkedAt,
    account: { telegramUserId: row.telegramUserId, firstName: row.firstName, username: row.username },
  };
}
function challengeState(challenge: Challenge): TelegramLinkState {
  if (challenge.telegramUserId !== null && challenge.firstName !== null) {
    return {
      kind: "confirm",
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      account: {
        telegramUserId: challenge.telegramUserId,
        firstName: challenge.firstName,
        username: challenge.username,
      },
    };
  }
  const url = new URL(`https://t.me/${challenge.botUsername}`);
  url.searchParams.set("start", `link_${linkToken(challenge.userId, challenge.id)}`);
  return { kind: "waiting", challengeId: challenge.id, expiresAt: challenge.expiresAt, linkUrl: url.href };
}

export async function readTelegramLinkState(db: AppDatabase, userId: string): Promise<TelegramLinkState> {
  const [connection] = await db
    .select()
    .from(telegramConnections)
    .where(eq(telegramConnections.userId, userId))
    .limit(1);
  if (connection !== undefined) {
    return linkedState(connection);
  }
  if (telegramConfig() === null) {
    return { kind: "unavailable" };
  }
  const [challenge] = await db
    .select()
    .from(telegramLinkChallenges)
    .where(eq(telegramLinkChallenges.userId, userId))
    .limit(1);
  return challenge === undefined || !validChallenge(challenge, await databaseTime(db))
    ? { kind: "unlinked" }
    : challengeState(challenge);
}

export async function beginTelegramLink(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<TelegramLinkState> {
  const input = beginTelegramLinkSchema.parse(raw);
  const botUsername = await telegramBotUsername();
  return userTransaction(db, userId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.userId, userId))
      .limit(1);
    if (connection !== undefined) {
      return linkedState(connection);
    }
    const now = await databaseTime(tx);
    const [current] = await tx
      .select()
      .from(telegramLinkChallenges)
      .where(eq(telegramLinkChallenges.userId, userId))
      .limit(1);
    if (current !== undefined && validChallenge(current, now)) {
      if (current.id === input.requestId) {
        return challengeState(current);
      }
      if (current.id !== input.expectedChallengeId) {
        throw new AgentError("conflict", "A newer Telegram link is waiting. Check its status first.");
      }
    }
    const challenge = {
      userId,
      id: input.requestId,
      tokenHash: executionHash(linkToken(userId, input.requestId)),
      botUsername,
      createdAt: now,
      expiresAt: now + LINK_TTL_MS,
      claimedAt: null,
      telegramUserId: null,
      chatId: null,
      firstName: null,
      username: null,
    };
    await tx.delete(telegramLinkChallenges).where(eq(telegramLinkChallenges.userId, userId));
    await tx.insert(telegramLinkChallenges).values(challenge);
    await auditAgent(tx, userId, null, "telegram_link_requested", "Telegram linking requested.", {
      challengeId: input.requestId,
    });
    return challengeState(challenge);
  });
}

/** Called only after webhook-secret verification and private-chat parsing. No connection is made here. */
export async function claimTelegramLink(db: AppDatabase, start: TelegramStart): Promise<boolean> {
  const tokenHash = executionHash(start.token);
  const [candidate] = await db
    .select()
    .from(telegramLinkChallenges)
    .where(eq(telegramLinkChallenges.tokenHash, tokenHash))
    .limit(1);
  if (candidate === undefined) {
    return false;
  }
  return userTransaction(db, candidate.userId, async (tx) => {
    const [challenge] = await tx
      .select()
      .from(telegramLinkChallenges)
      .where(
        and(
          eq(telegramLinkChallenges.userId, candidate.userId),
          eq(telegramLinkChallenges.tokenHash, tokenHash),
        ),
      )
      .limit(1);
    if (challenge === undefined || !validChallenge(challenge, await databaseTime(tx))) {
      return false;
    }
    if (challenge.claimedAt !== null) {
      return challenge.telegramUserId === start.telegramUserId && challenge.chatId === start.chatId;
    }
    if (start.chatId !== start.telegramUserId) {
      return false;
    }
    await tx
      .update(telegramLinkChallenges)
      .set({
        claimedAt: await databaseTime(tx),
        telegramUserId: start.telegramUserId,
        chatId: start.chatId,
        firstName: start.firstName,
        username: start.username,
      })
      .where(eq(telegramLinkChallenges.userId, candidate.userId));
    return true;
  });
}

export async function confirmTelegramLink(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<TelegramLinkState> {
  const input = confirmTelegramLinkSchema.parse(raw);
  return userTransaction(db, userId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.userId, userId))
      .limit(1);
    if (existing !== undefined) {
      if (existing.linkId !== input.challengeId || existing.telegramUserId !== input.telegramUserId) {
        throw new AgentError("conflict", "Your Telegram connection changed. Review it first.");
      }
      return linkedState(existing);
    }
    const [challenge] = await tx
      .select()
      .from(telegramLinkChallenges)
      .where(eq(telegramLinkChallenges.userId, userId))
      .limit(1);
    const now = await databaseTime(tx);
    if (
      challenge === undefined ||
      challenge.id !== input.challengeId ||
      !validChallenge(challenge, now) ||
      challenge.claimedAt === null ||
      challenge.telegramUserId !== input.telegramUserId ||
      challenge.chatId === null ||
      challenge.firstName === null
    ) {
      throw new AgentError("conflict", "This Telegram link expired or changed. Create a new link.");
    }
    const [connection] = await tx
      .insert(telegramConnections)
      .values({
        userId,
        linkId: challenge.id,
        telegramUserId: challenge.telegramUserId,
        chatId: challenge.chatId,
        firstName: challenge.firstName,
        username: challenge.username,
        linkedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (connection === undefined) {
      throw new AgentError(
        "conflict",
        "This Telegram account is already linked. Unlink it before trying again.",
      );
    }
    await tx.delete(telegramLinkChallenges).where(eq(telegramLinkChallenges.userId, userId));
    await auditAgent(tx, userId, null, "telegram_linked", "Telegram account linked.", {
      linkId: connection.linkId,
    });
    return linkedState(connection);
  });
}

export async function cancelTelegramLink(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<TelegramLinkState> {
  const input = cancelTelegramLinkSchema.parse(raw);
  return userTransaction(db, userId, async (tx) => {
    await tx
      .delete(telegramLinkChallenges)
      .where(
        and(eq(telegramLinkChallenges.userId, userId), eq(telegramLinkChallenges.id, input.challengeId)),
      );
    return readTelegramLinkState(tx, userId);
  });
}

export async function unlinkTelegram(
  db: AppDatabase,
  userId: string,
  raw: unknown,
): Promise<TelegramLinkState> {
  const input = unlinkTelegramSchema.parse(raw);
  return userTransaction(db, userId, async (tx) => {
    const [connection] = await tx
      .select()
      .from(telegramConnections)
      .where(eq(telegramConnections.userId, userId))
      .limit(1);
    if (connection === undefined) {
      return readTelegramLinkState(tx, userId);
    }
    if (connection.linkId !== input.linkId) {
      throw new AgentError("conflict", "Your Telegram connection changed. Review it before unlinking.");
    }
    await tx.delete(telegramConnections).where(eq(telegramConnections.userId, userId));
    await tx.delete(telegramLinkChallenges).where(eq(telegramLinkChallenges.userId, userId));
    await auditAgent(tx, userId, null, "telegram_unlinked", "Telegram account unlinked.", {
      linkId: input.linkId,
    });
    return telegramConfig() === null ? { kind: "unavailable" } : { kind: "unlinked" };
  });
}
