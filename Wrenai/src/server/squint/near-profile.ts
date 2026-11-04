import "server-only";
import { z } from "zod";
import { assetUsdPrice } from "@/server/engine/instruction-price";
import { ExecutionError } from "@/server/execution/contracts";
import { callViewFunction, finalBlockTime, readContractControl } from "@/server/near/rpc";
import { compare, decimal } from "@/server/research/decimal";
import type { AgentInstruction } from "@/shared/agent-instructions";
import { positiveTokenUnitsSchema } from "@/shared/token-units";
import type { TradeAsset } from "@/shared/trade-preview";
import { screenMemeReport } from "./assessment";
import type { SquintReport } from "./contracts";
import type { MemeEvidence } from "./near-profile-contracts";

// Reviewed source/release pins, not an audit claim. Tax tokens and legacy implementations are excluded.
// https://github.com/sam3dsol/Nearlytrade/tree/3d59877216c93e56309f7c21568eaa3d17bccfc0/contracts
const FACTORY = "nearlytrade.near",
  LOCKER = "lock_8.nearlytrade.near";
const FACTORY_HASH = "9mwfrbtBbDr3y2t9rHY944qAQTU2PsB5smqsAHZJo4G5";
const RAW_HASH = "54GH1DmZgArERRH2ed8zJBXT7UxdeumaZe8Du8dtYJrt";
const LOCKER_HASH = "4CMfhWsUNfXgotni5nnt9vePC1dpb4aQF8x1KQjoyG6u";
export const MEME_DCL = "dclv2.ref-labs.near";
const launchSchema = z.object({
  id: z.number().int().nonnegative().safe(),
  token: z.string(),
  creator: z.string(),
  created_at_ms: z.number().int().positive().safe(),
  total_supply: positiveTokenUnitsSchema,
  pool_id: z.string().max(200),
  lpt_id: z.string().max(240),
  step: z.literal("Done"),
  inflight: z.literal(false),
  quote: z.literal("wrap.near"),
  left_point: z.number().int(),
  right_point: z.number().int(),
});
export const memePoolSchema = z.object({
  pool_id: z.string(),
  token_x: z.string(),
  token_y: z.string(),
  state: z.literal("Running"),
  total_x: positiveTokenUnitsSchema,
  total_y: positiveTokenUnitsSchema,
  total_liquidity: positiveTokenUnitsSchema,
  whitelist: z.null(),
  tax: z.null(),
});
type MemeInstruction = Extract<AgentInstruction, { kind: "meme_hunter" }>;
function reject(reason: string): never {
  throw new ExecutionError("not_ready", reason);
}
function pinnedCode(control: Awaited<ReturnType<typeof readContractControl>>, hash: string): boolean {
  return (
    control.globalCodeAccount === null &&
    (control.globalCodeHash === null
      ? control.codeHash === hash
      : control.globalCodeHash === hash && control.codeHash === "11111111111111111111111111111111")
  );
}

/** One bounded, exact-contract profile. Unknown programs, launch rules, LP owners or taxes never pass. */
export async function verifyMemeContract(
  report: SquintReport,
  asset: TradeAsset,
  instruction: MemeInstruction,
  reportHash: string,
): Promise<MemeEvidence> {
  const screen = screenMemeReport(report, instruction, Date.now());
  if (!screen.passed) {
    reject(screen.reasons[0] ?? "The risk screen did not pass.");
  }
  if (
    asset.blockchain.toLowerCase() !== "near" ||
    asset.assetId !== `nep141:${report.token}` ||
    asset.contractAddress !== report.token ||
    report.launchpad.id !== "nearly"
  ) {
    reject("This exact launch has no reviewed immutable token profile.");
  }
  const factory = await readContractControl(FACTORY);
  if (!pinnedCode(factory, FACTORY_HASH)) {
    reject("The reviewed launch factory code changed.");
  }
  const at = factory.blockHash;
  const blockAt = await finalBlockTime(at);
  if (blockAt > Date.now() + 1000 || Date.now() - blockAt >= 15000) {
    reject("The final contract observation is stale.");
  }
  const launch = launchSchema.parse(
    (await callViewFunction(FACTORY, "get_launch_by_token", { token: report.token }, undefined, at)).value,
  );
  if (
    launch.token !== report.token ||
    launch.creator !== report.creator ||
    launch.created_at_ms > Date.now() ||
    Date.now() - launch.created_at_ms > instruction.maximumAgeSeconds * 1000 ||
    Math.abs(launch.created_at_ms - Date.parse(report.created_at ?? "")) > 1000
  ) {
    reject("The final launch record does not match this token, creator or listing window.");
  }
  const [locker, dcl] = await Promise.all([
    callViewFunction(FACTORY, "get_locker_for", { launch_id: String(launch.id) }, undefined, at),
    callViewFunction(FACTORY, "get_dcl_for", { launch_id: String(launch.id) }, undefined, at),
  ]);
  if (locker.value !== LOCKER || dcl.value !== MEME_DCL) {
    reject("This launch's liquidity locker or exchange is outside the reviewed profile.");
  }
  const [
    tokenControl,
    lockerControl,
    metadata,
    supply,
    rules,
    poolValue,
    positionValue,
    recordValue,
    lockerDcl,
  ] = await Promise.all([
    readContractControl(report.token, at),
    readContractControl(LOCKER, at),
    callViewFunction(report.token, "ft_metadata", {}, undefined, at),
    callViewFunction(report.token, "ft_total_supply", {}, undefined, at),
    callViewFunction(report.token, "get_rules", {}, undefined, at),
    callViewFunction(MEME_DCL, "get_pool", { pool_id: launch.pool_id }, undefined, at),
    callViewFunction(MEME_DCL, "get_liquidity", { lpt_id: launch.lpt_id }, undefined, at),
    callViewFunction(LOCKER, "get_position", { pool_id: launch.pool_id }, undefined, at),
    callViewFunction(LOCKER, "get_dcl", {}, undefined, at),
  ]);
  if (
    !pinnedCode(tokenControl, RAW_HASH) ||
    tokenControl.keys.length ||
    !pinnedCode(lockerControl, LOCKER_HASH) ||
    lockerControl.keys.length ||
    lockerDcl.value !== MEME_DCL
  ) {
    reject("The token/locker code or upgrade controls are not the reviewed keyless profile.");
  }
  const meta = z.object({ spec: z.literal("ft-1.0.0"), decimals: z.literal(18) }).parse(metadata.value);
  if (
    asset.decimals !== meta.decimals ||
    positiveTokenUnitsSchema.parse(supply.value) !== launch.total_supply ||
    launch.total_supply !== "1000000000000000000000000000"
  ) {
    reject("The finalized decimals or fixed token supply do not match the route.");
  }
  const rule = z
    .object({ until_ms: z.string().regex(/^\d{1,16}$/) })
    .nullable()
    .parse(rules.value);
  if (rule && BigInt(rule.until_ms) > BigInt(Date.now())) {
    reject("Launch-window transfer restrictions have not expired.");
  }
  const pool = memePoolSchema.parse(poolValue.value);
  const position = z
    .object({
      lpt_id: z.string(),
      owner_id: z.literal(LOCKER),
      pool_id: z.string(),
      left_point: z.number().int(),
      right_point: z.number().int(),
      amount: positiveTokenUnitsSchema,
      mft_id: z.literal(""),
    })
    .parse(positionValue.value);
  const record = z.object({ lpt_id: z.string(), refunded: z.literal(false) }).parse(recordValue.value);
  if (
    pool.pool_id !== launch.pool_id ||
    `${pool.token_x}|${pool.token_y}|10000` !== launch.pool_id ||
    ![pool.token_x, pool.token_y].includes(report.token) ||
    ![pool.token_x, pool.token_y].includes("wrap.near") ||
    position.lpt_id !== launch.lpt_id ||
    record.lpt_id !== launch.lpt_id ||
    position.pool_id !== launch.pool_id ||
    position.amount !== pool.total_liquidity ||
    position.left_point !== launch.left_point ||
    position.right_point !== launch.right_point
  ) {
    reject("The exact pool reserves and fully locked liquidity position do not match the launch.");
  }
  const nearUnits = pool.token_x === "wrap.near" ? pool.total_x : pool.total_y;
  const nearPrice = await assetUsdPrice("nep141:wrap.near");
  if (
    compare(
      { n: BigInt(nearUnits) * nearPrice.n, d: 10n ** 24n * nearPrice.d },
      decimal(instruction.minimumLiquidityUsd),
    ) < 0
  ) {
    reject("The pool's verified NEAR-side reserves are below the reviewed USD liquidity minimum.");
  }
  if (
    Date.now() - blockAt >= 15000 ||
    Date.now() - screen.checkedAt >= 60000 ||
    nearPrice.observedAt > Date.now() + 1000 ||
    Date.now() - nearPrice.observedAt >= 5000
  ) {
    reject("The contract, risk or liquidity-price evidence expired during its checks.");
  }
  return {
    profile: "nearly-raw-v6-lock8",
    token: report.token,
    poolId: launch.pool_id,
    createdAt: launch.created_at_ms,
    observedAt: blockAt,
    riskCheckedAt: screen.checkedAt,
    reportHash,
    blockHash: at,
    blockHeight: factory.blockHeight,
    liquidityNearUnits: nearUnits,
  };
}
