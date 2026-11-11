import { z } from "zod";
import { positiveTokenUnitsSchema, tokenUnitsSchema } from "@/shared/token-units";
import { hashSchema, scopeSchema } from "./contracts";

const assetId = z.string().min(1).max(256).regex(/^\S+$/);
/** Where each balance location sends a wallet return. Perps venue cash returns through its own route first. */
export const WALLET_RETURN_VENUES = {
  confidential: "confidential-intents",
  intents: "near-intents",
  native_near: "near-account",
  hyperliquid: null,
} as const;
const reference = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const operationSchema = z.enum([
  "add_liquidity",
  "remove_liquidity",
  "supply",
  "withdraw",
  "borrow",
  "repay",
  "stake",
  "unstake",
  "perp_open",
  "perp_reduce",
  "transfer",
]);
export const positionKindSchema = z.enum([
  "lp_share",
  "collateral",
  "debt",
  "staking",
  "perp_long",
  "perp_short",
]);
const cashLimitSchema = z.strictObject({
  assetId,
  scope: scopeSchema.optional(),
  maxDebitUnits: tokenUnitsSchema,
  minCreditUnits: tokenUnitsSchema,
});
const positionLimitSchema = z.strictObject({
  positionId: z.uuid(),
  kind: positionKindSchema,
  instrumentId: assetId,
  // Compare-and-set the complete position. A receipt cannot overwrite another action's state.
  expectedVersion: z.number().int().nonnegative(),
  beforeUnits: tokenUnitsSchema,
  minAfterUnits: tokenUnitsSchema,
  maxAfterUnits: tokenUnitsSchema,
});
const defiPlanFields = z.strictObject({
  format: z.literal(2),
  requestId: z.uuid(),
  agentId: z.uuid(),
  agentRevision: z.number().int().positive(),
  strategyVersion: z.number().int().positive(),
  riskPolicyRevision: z.number().int().nonnegative(),
  budgetMode: z.enum(["per_agent", "manual"]).optional(),
  manualTradeId: z.uuid().optional(),
  reduceOnly: z.literal(true).optional(),
  funding: z.literal(true).optional(),
  walletFundingId: z.uuid().optional(),
  returnFunds: z.literal(true).optional(),
  // The owner deleted the agent: send one held token back to the owner's own NEAR wallet, as held.
  walletReturn: z.literal(true).optional(),
  // A wallet return the owner chose to receive in another NEAR token: 1Click swaps on the way out.
  payoutAssetId: reference.optional(),
  fundingFeeUnits: tokenUnitsSchema.optional(),
  scope: scopeSchema,
  operation: operationSchema,
  venueId: reference,
  permissionHash: hashSchema,
  cash: z.array(cashLimitSchema).min(1).max(12),
  positions: z.array(positionLimitSchema).max(8),
  // Includes maximum leveraged exposure and excluded fees, not just the cash collateral.
  notionalMicroUsd: positiveTokenUnitsSchema,
  slippageBps: z.number().int().min(0).max(500),
  providerFeeBps: z.number().int().min(0).max(2000),
  quoteId: reference,
  quoteHash: hashSchema,
  payloadHash: hashSchema,
  recipient: reference.nullable(),
  expiresAt: time,
});
const operationPositionKinds = {
  add_liquidity: ["lp_share"],
  remove_liquidity: ["lp_share"],
  supply: ["collateral"],
  withdraw: ["collateral"],
  borrow: ["debt", "collateral"],
  repay: ["debt", "collateral"],
  stake: ["staking"],
  unstake: ["staking"],
  perp_open: ["perp_long", "perp_short", "collateral"],
  perp_reduce: ["perp_long", "perp_short", "collateral"],
  transfer: [],
} as const;
export const defiPlanSchema = defiPlanFields.pipe(
  defiPlanFields.superRefine((plan, ctx) => {
    if ((plan.budgetMode === "manual") !== (plan.manualTradeId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Manual orders require an exact confirmation binding." });
    }
    if (
      plan.walletFundingId &&
      (!plan.funding ||
        plan.returnFunds ||
        plan.scope !== "intents" ||
        plan.venueId !== "near-intents" ||
        plan.positions.length !== 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Wallet funding requires a bound public-to-private owner transfer.",
      });
    }
    if (
      plan.walletReturn &&
      (plan.funding ||
        plan.returnFunds ||
        plan.walletFundingId ||
        // A deleted agent's return, or the owner's confirmed return of unassigned private balance.
        plan.budgetMode === undefined ||
        plan.operation !== "transfer" ||
        plan.cash.length !== 1 ||
        plan.cash[0]?.scope !== undefined ||
        plan.cash[0]?.minCreditUnits !== "0" ||
        plan.venueId !== WALLET_RETURN_VENUES[plan.scope])
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A wallet return moves one held token from its own balance to the owner's wallet.",
      });
    }
    if (
      plan.payoutAssetId !== undefined &&
      (!plan.walletReturn || plan.payoutAssetId === plan.cash[0]?.assetId)
    ) {
      ctx.addIssue({ code: "custom", message: "Only a wallet return can pay out in a different token." });
    }
    if (
      (plan.returnFunds &&
        (!plan.funding || plan.scope !== "hyperliquid" || plan.fundingFeeUnits !== "1000000")) ||
      (plan.fundingFeeUnits !== undefined &&
        (!plan.returnFunds ||
          !plan.cash.some((cash) => BigInt(cash.maxDebitUnits) > BigInt(plan.fundingFeeUnits ?? "0"))))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "The return transfer must bind its exact non-refundable source fee.",
      });
    }
    if (
      plan.cash.some(
        (cash) =>
          cash.scope !== undefined &&
          cash.scope !== plan.scope &&
          (plan.operation !== "transfer" || cash.maxDebitUnits !== "0" || !plan.funding),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A foreign-location credit requires an explicit owned-account funding transfer.",
      });
    }
    if (
      plan.funding &&
      (plan.operation !== "transfer" ||
        plan.budgetMode === undefined ||
        plan.cash.length !== 2 ||
        plan.cash.filter((cash) => BigInt(cash.maxDebitUnits) > 0n).length !== 1 ||
        !plan.cash.some(
          (cash) => cash.scope !== undefined && cash.scope !== plan.scope && BigInt(cash.minCreditUnits) > 0n,
        ))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Funding must bind one source debit and one foreign-location credit.",
      });
    }
    if (plan.reduceOnly && (plan.budgetMode === undefined || plan.operation !== "perp_reduce")) {
      ctx.addIssue({
        code: "custom",
        message: "Only position-reducing per-agent exits can request the protection exception.",
      });
    }
    if (plan.budgetMode !== undefined ? plan.riskPolicyRevision !== 0 : plan.riskPolicyRevision <= 0) {
      ctx.addIssue({ code: "custom", message: "An action must explicitly bind its budget policy." });
    }
    if (
      new Set(plan.cash.map((a) => `${a.scope ?? plan.scope}:${a.assetId}`)).size !== plan.cash.length ||
      new Set(plan.positions.map((p) => p.positionId)).size !== plan.positions.length ||
      new Set(plan.positions.map((p) => `${p.kind}:${p.instrumentId}`)).size !== plan.positions.length
    ) {
      ctx.addIssue({ code: "custom", message: "An action cannot repeat a cash asset or position." });
    }
    for (const p of plan.positions) {
      if (
        BigInt(p.minAfterUnits) > BigInt(p.maxAfterUnits) ||
        (p.expectedVersion === 0 && p.beforeUnits !== "0")
      ) {
        ctx.addIssue({ code: "custom", message: "The position bounds are inconsistent." });
      }
    }
    if (plan.operation === "transfer" && plan.positions.length !== 0) {
      ctx.addIssue({ code: "custom", message: "A payment cannot change DeFi positions." });
    }
    if ((plan.operation === "transfer") !== (plan.recipient !== null)) {
      ctx.addIssue({ code: "custom", message: "Only payments require an explicit recipient." });
    }
    const allowedKinds: readonly string[] = operationPositionKinds[plan.operation];
    if (
      plan.positions.some((p) => !allowedKinds.includes(p.kind)) ||
      (plan.operation !== "transfer" && plan.positions.length === 0)
    ) {
      ctx.addIssue({ code: "custom", message: "The operation has incompatible position types." });
    }
    if (
      (plan.operation === "borrow" || plan.operation === "repay") &&
      !plan.positions.some((p) => p.kind === "debt")
    ) {
      ctx.addIssue({ code: "custom", message: "Borrowing and repayment require an explicit debt position." });
    }
    if (
      (plan.operation === "perp_open" || plan.operation === "perp_reduce") &&
      !plan.positions.some((p) => p.kind === "perp_long" || p.kind === "perp_short")
    ) {
      ctx.addIssue({ code: "custom", message: "Perpetuals require an explicit exposure position." });
    }
    for (const p of plan.positions) {
      const auxiliary =
        p.kind === "collateral" && ["borrow", "repay", "perp_open", "perp_reduce"].includes(plan.operation);
      const increasing = ["add_liquidity", "supply", "borrow", "stake", "perp_open"].includes(plan.operation);
      if (
        !auxiliary &&
        ((increasing && BigInt(p.minAfterUnits) < BigInt(p.beforeUnits)) ||
          (!increasing && BigInt(p.maxAfterUnits) > BigInt(p.beforeUnits)))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "The position direction differs from the approved operation.",
        });
      }
    }
    if (
      plan.operation === "transfer" &&
      ((!plan.funding && plan.cash.length !== 1) || !plan.cash.some((a) => BigInt(a.maxDebitUnits) > 0n))
    ) {
      ctx.addIssue({ code: "custom", message: "A payment requires one positive asset debit." });
    }
  }),
);
export type DefiPlan = z.infer<typeof defiPlanSchema>;

export const defiReceiptSchema = z.strictObject({
  fundingRefund: z.literal(true).optional(),
  providerEventId: reference,
  riskDebitMicroUsd: positiveTokenUnitsSchema,
  // Fee metadata is already included in riskDebitMicroUsd and is never charged a second time.
  feeMicroUsd: tokenUnitsSchema.nullable(),
  cash: z
    .array(
      z.strictObject({
        assetId,
        scope: scopeSchema.optional(),
        debitUnits: tokenUnitsSchema,
        creditUnits: tokenUnitsSchema,
        creditValueMicroUsd: tokenUnitsSchema.nullable(),
        creditPrincipalMicroUsd: tokenUnitsSchema,
      }),
    )
    .min(1)
    .max(12),
  positions: z
    .array(
      z.strictObject({
        positionId: z.uuid(),
        afterUnits: tokenUnitsSchema,
        principalMicroUsd: tokenUnitsSchema,
      }),
    )
    .max(8),
  // Principal can leave only through a real payment, repayment, fee or realized loss.
  retiredPrincipalMicroUsd: tokenUnitsSchema,
  // Borrowed proceeds count against gross allocated capital; a loan must not create unbudgeted cash.
  borrowedCapitalMicroUsd: tokenUnitsSchema,
  occurredAt: time,
});
export type DefiReceipt = z.infer<typeof defiReceiptSchema>;

export const executionPermissionSchema = z
  .strictObject({
    agentId: z.uuid(),
    agentRevision: z.number().int().positive(),
    strategyVersion: z.number().int().positive(),
    scope: scopeSchema,
    venueId: reference,
    signingPublicKey: reference,
    operations: z.array(operationSchema).min(1).max(11),
    assetIds: z.array(assetId).min(1).max(12),
    instruments: z
      .array(
        z.strictObject({
          kind: positionKindSchema,
          instrumentId: assetId,
          maxUnits: positiveTokenUnitsSchema,
        }),
      )
      .max(8),
    recipients: z.array(reference).max(25),
    expiresAt: time.nullable(),
  })
  .refine(
    (p) =>
      new Set(p.assetIds).size === p.assetIds.length &&
      new Set(p.operations).size === p.operations.length &&
      new Set(p.instruments.map((i) => `${i.kind}:${i.instrumentId}`)).size === p.instruments.length,
    "Execution permissions contain duplicates.",
  );
export type ExecutionPermission = z.infer<typeof executionPermissionSchema>;
