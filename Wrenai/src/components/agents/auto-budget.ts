import { type AgentBudgetInput, budgetTokenAmount } from "@/shared/agent-budget";
import type { BudgetHint } from "@/shared/budget-hint";
import { parseTokenAmount } from "@/shared/token-units";

/** A budget read from the instructions, with the line that says so beside the budget. */
export interface BudgetSuggestion {
  readonly budget: AgentBudgetInput;
  readonly note: string;
}

export interface BudgetCandidate {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  /** What the user can still allocate; the suggestion never exceeds it. Unknown when absent. */
  readonly availableUnits?: string;
}

/** No more fraction digits than the token has, so the exact amount always fits its smallest unit. */
function fits(amount: string, decimals: number): boolean {
  return (amount.split(".")[1]?.length ?? 0) <= decimals;
}

/**
 * Lowers a total that is more than is available to the most whole orders that fit, so the agent can run them all.
 * Null when not even one order fits; the total then stands and the budget control shows what is available.
 */
function capped(
  total: bigint,
  perOrder: string | null,
  token: BudgetCandidate,
): { readonly units: bigint; readonly orders: number | null } | null {
  if (token.availableUnits === undefined) {
    return null;
  }
  const available = BigInt(token.availableUnits);
  if (total <= available) {
    return null;
  }
  const each =
    perOrder !== null && fits(perOrder, token.decimals) ? parseTokenAmount(perOrder, token.decimals) : 0n;
  if (each <= 0n) {
    return available > 0n ? { units: available, orders: null } : null;
  }
  const orders = available / each;
  return orders > 0n ? { units: orders * each, orders: Number(orders) } : null;
}

/**
 * Matches the hint's token to exactly one candidate, by symbol or NEAR contract, and turns it into a budget. Two
 * tokens with the same symbol, an unknown token or more decimals than the token has give no amount.
 */
export function suggestBudget(
  hint: BudgetHint | null,
  candidates: readonly BudgetCandidate[],
): BudgetSuggestion | null {
  if (!hint) {
    return null;
  }
  const wanted = hint.symbol.toLowerCase();
  const matches = candidates.filter(
    (token) => token.symbol.toLowerCase() === wanted || token.assetId.toLowerCase() === `nep141:${wanted}`,
  );
  const [token] = matches;
  if (!token || matches.length > 1) {
    return null;
  }
  if (hint.amount === null || !fits(hint.amount, token.decimals)) {
    return {
      budget: { assetId: token.assetId, amount: "" },
      note: "Token set from your instructions. Enter the total for all orders.",
    };
  }
  const limit = capped(parseTokenAmount(hint.amount, token.decimals), hint.perOrder, token);
  if (limit) {
    const amount = budgetTokenAmount(limit.units.toString(), token.decimals);
    return {
      budget: { assetId: token.assetId, amount },
      note: `Your instructions need ${hint.amount} ${token.symbol}; set to the ${amount} available${
        limit.orders === null ? "" : `, ${limit.orders} ${limit.orders === 1 ? "order" : "orders"}`
      }.`,
    };
  }
  return {
    budget: { assetId: token.assetId, amount: hint.amount },
    note: `Set from your instructions: ${hint.amount} ${token.symbol}${hint.basis ? ` (${hint.basis})` : ""}.`,
  };
}
