import { suggestBudget } from "@/components/agents/auto-budget";
import type { BudgetNote } from "@/components/agents/create-agent-fields";
import { resolveInstructionBudget } from "@/components/agents/use-instruction-budget";
import type { AgentBudgetInput } from "@/shared/agent-budget";
import { parseBudgetHint } from "@/shared/budget-hint";
import { TESTNET_ASSETS, type TestnetLocation, type TestnetSnapshot } from "@/shared/testnet";

type Balance = TestnetSnapshot["balances"][number];

function free(balance: Balance): bigint {
  return BigInt(balance.units) - BigInt(balance.reserved);
}

/**
 * The guest's budget from its instructions: the token and total they imply, at the balance location they name
 * (or the one holding the most of that token), never more than is free there. Derived in render like mainnet's.
 */
export function testnetInstructionBudget(
  text: string,
  tool: string,
  balances: readonly Balance[],
  stored: { readonly budget: AgentBudgetInput | null; readonly location: TestnetLocation },
  touched: boolean,
  onApply: () => void,
): {
  readonly budget: AgentBudgetInput | null;
  readonly location: TestnetLocation;
  readonly note: BudgetNote | null;
} {
  const hint = parseBudgetHint(text, tool === "dca");
  const asset = hint
    ? TESTNET_ASSETS.find((a) => a.symbol.toLowerCase() === hint.symbol.toLowerCase())
    : undefined;
  // Native NEAR is wallet-only; otherwise the named location, or the one with the most free units.
  const options = balances.filter((b) => b.assetId === asset?.id && free(b) > 0n);
  const named = hint?.location ? options.find((b) => b.location === hint.location) : undefined;
  const best = named ?? options.toSorted((a, b) => (free(b) > free(a) ? 1 : free(b) < free(a) ? -1 : 0))[0];
  const suggestion = suggestBudget(
    hint,
    TESTNET_ASSETS.map((a) => ({
      assetId: a.id,
      symbol: a.symbol,
      decimals: a.decimals,
      ...(a.id === best?.assetId ? { availableUnits: free(best).toString() } : {}),
    })),
  );
  const resolved = resolveInstructionBudget(suggestion, stored.budget, touched, onApply);
  const following = suggestion !== null && !touched;
  if (following && !best) {
    const where =
      hint?.location === "wallet" ? "your wallet" : hint?.location ? "Public Intents" : "this session";
    return {
      ...resolved,
      location: stored.location,
      note: { text: `No free ${asset?.symbol ?? "funds"} in ${where} for this budget.`, onApply: null },
    };
  }
  return { ...resolved, location: following && best ? best.location : stored.location };
}
