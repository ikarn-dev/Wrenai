import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { base64urlnopad } from "@scure/base";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { nearAccountIdSchema } from "@/server/near/account-id";
import { decodeSignature, parseEd25519PublicKey, verifyNep413Signature } from "@/server/near/nep413";
import { TestnetError, testnetEnv } from "./config";
import { type TestnetDatabase, testnetDatabase } from "./database";
import { expireTestnetGuest, reclaimAbandonedGuests } from "./expiry";
import { grantGuest, poolObservations, poolTransaction, type TestnetOwner } from "./pool";
import { testnetChain, testnetRpc } from "./rpc";
import { tnChallenges, tnOwners, tnSessions } from "./schema";

const COOKIE = "wrenai_testnet_session";
const GUEST_COOKIE = "wrenai_testnet_guest";
export const TESTNET_SIGN_IN = "Sign in to Wrenai on NEAR testnet. This does not authorize transfers.";
export function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export async function testnetOwner(db: TestnetDatabase = testnetDatabase()): Promise<TestnetOwner | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) {
    return null;
  }
  const [row] = await db
    .select({ owner: tnOwners })
    .from(tnSessions)
    .innerJoin(tnOwners, eq(tnSessions.ownerId, tnOwners.id))
    .where(
      and(
        eq(tnSessions.hash, sessionHash(token)),
        gt(tnSessions.expiresAt, Date.now()),
        gt(tnOwners.expiresAt, Date.now()),
      ),
    )
    .limit(1);
  return row?.owner ?? null;
}
async function setSession(db: TestnetDatabase, owner: TestnetOwner): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db
    .insert(tnSessions)
    .values({ hash: sessionHash(token), ownerId: owner.id, expiresAt: owner.expiresAt });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: new URL(testnetEnv().origin).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor((owner.expiresAt - Date.now()) / 1000)),
  });
}
export async function beginGuest(db: TestnetDatabase): Promise<TestnetOwner> {
  const existing = await testnetOwner(db);
  if (existing?.kind === "guest") {
    return existing;
  }
  const identity = (await cookies()).get(GUEST_COOKIE)?.value;
  if (!identity) {
    throw new TestnetError("conflict", "Reload Testnet before starting a guest session.");
  }
  const guestIdentity = sessionHash(identity);
  const [previous] = await db.select().from(tnOwners).where(eq(tnOwners.guestIdentity, guestIdentity));
  if (previous && previous.expiresAt <= Date.now()) {
    // Close the ended session first (stops its agents, settles or rejects its orders). Idempotent: the expiry
    // workflow may already have done it. It can change the pool, so the pool is observed only afterwards.
    await expireTestnetGuest(db, previous.id);
  }
  const observations = await poolObservations(db),
    env = testnetEnv(),
    now = Date.now(),
    expiresAt = now + env.TESTNET_GUEST_TTL_HOURS * 3600000;
  const granted = await poolTransaction(db, async (tx) => {
    const [prior] = await tx.select().from(tnOwners).where(eq(tnOwners.guestIdentity, guestIdentity));
    if (prior && prior.expiresAt > now) {
      return prior;
    }
    // A returning guest continues on the same identity: its holdings, agents, orders and chats stay, and its
    // starter tokens are topped back up. Per-guest order and turnover caps count from `createdAt`.
    const owner: TestnetOwner = prior
      ? { ...prior, createdAt: now, expiresAt }
      : { id: randomUUID(), kind: "guest", guestIdentity, accountId: null, createdAt: now, expiresAt };
    if (prior) {
      await tx.update(tnOwners).set({ createdAt: now, expiresAt }).where(eq(tnOwners.id, prior.id));
    } else {
      await tx.insert(tnOwners).values(owner);
    }
    await reclaimAbandonedGuests(tx, now);
    await grantGuest(tx, owner, observations.balances, observations.revision);
    return owner;
  });
  await setSession(db, granted);
  return granted;
}
export async function testnetChallenge(
  db: TestnetDatabase,
): Promise<{ nonce: string; message: string; recipient: string }> {
  const nonce = randomBytes(32).toString("base64url");
  await db.insert(tnChallenges).values({ nonce, expiresAt: Date.now() + 300000 });
  return { nonce, message: TESTNET_SIGN_IN, recipient: new URL(testnetEnv().origin).host };
}
export async function connectTestnet(
  db: TestnetDatabase,
  input: { nonce: string; accountId: string; publicKey: string; signature: string },
): Promise<void> {
  const accountId = nearAccountIdSchema.parse(input.accountId),
    key = parseEd25519PublicKey(input.publicKey),
    signature = decodeSignature(input.signature);
  const [used] = await db
    .update(tnChallenges)
    .set({ consumedAt: Date.now() })
    .where(
      and(
        eq(tnChallenges.nonce, input.nonce),
        gt(tnChallenges.expiresAt, Date.now()),
        isNull(tnChallenges.consumedAt),
      ),
    )
    .returning();
  if (
    !used ||
    !key ||
    !signature ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
    !verifyNep413Signature({
      publicKey: key,
      signature,
      payload: {
        message: TESTNET_SIGN_IN,
        nonce: base64urlnopad.decode(input.nonce),
        recipient: new URL(testnetEnv().origin).host,
      },
    })
  ) {
    throw new TestnetError("unauthorized", "The testnet sign-in challenge is invalid or expired.");
  }
  await testnetChain();
  const access = await testnetRpc("query", {
    request_type: "view_access_key",
    account_id: accountId,
    public_key: input.publicKey,
    finality: "final",
  });
  if (
    !access ||
    typeof access !== "object" ||
    !("permission" in access) ||
    access.permission !== "FullAccess"
  ) {
    throw new TestnetError("unauthorized", "Use a funded testnet account and full-access signing key.");
  }
  const now = Date.now();
  const [owner] = await db
    .insert(tnOwners)
    .values({ id: randomUUID(), kind: "wallet", accountId, createdAt: now, expiresAt: now + 86400000 })
    .onConflictDoUpdate({ target: tnOwners.accountId, set: { expiresAt: now + 86400000 } })
    .returning();
  if (!owner) {
    throw new TestnetError("unavailable", "Could not save this testnet session.");
  }
  await setSession(db, owner);
}
export async function logoutTestnet(db: TestnetDatabase): Promise<void> {
  const jar = await cookies(),
    token = jar.get(COOKIE)?.value;
  if (token) {
    const owner = await testnetOwner(db);
    if (owner?.kind === "guest") {
      await db.update(tnOwners).set({ expiresAt: Date.now() }).where(eq(tnOwners.id, owner.id));
    }
    await db.delete(tnSessions).where(eq(tnSessions.hash, sessionHash(token)));
  }
  jar.delete(COOKIE);
}

export async function prepareGuestIdentity(): Promise<void> {
  const jar = await cookies();
  if (!jar.get(GUEST_COOKIE)) {
    jar.set(GUEST_COOKIE, randomBytes(32).toString("base64url"), {
      httpOnly: true,
      secure: new URL(testnetEnv().origin).protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 2592000,
    });
  }
}
