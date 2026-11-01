import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { database } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { serverEnv } from "@/server/env";

const SESSION_COOKIE = "wrenai_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  readonly id: string;
  readonly accountId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a session and sets its cookie. Call only from a Server Action or Route Handler. */
export async function startSession(userId: string): Promise<void> {
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const db = database();
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db
    .insert(sessions)
    .values({ tokenHash: hashToken(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: serverEnv().secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

// React discards this cache between server requests; authorization never enters a shared process cache.
const readSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined) {
    return null;
  }
  const [row] = await database()
    .select({ id: users.id, accountId: users.accountId })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, Date.now())))
    .limit(1);
  return row ?? null;
});

/** The signed-in user, or null when there is no valid session. */
export async function currentUser(): Promise<SessionUser | null> {
  return readSessionUser();
}

/** The signed-in user; redirects to sign-in when there is none. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) {
    redirect("/");
  }
  return user;
}

/** Deletes the session and its cookie. Call only from a Server Action or Route Handler. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token !== undefined) {
    await database()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}
