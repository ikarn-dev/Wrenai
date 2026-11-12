"use client";

import type { AgentBudgetInput } from "@/shared/agent-budget";
import { parseBudgetHint } from "@/shared/budget-hint";
import { type BudgetSuggestion, suggestBudget } from "./auto-budget";
import type { BudgetNote } from "./create-agent-fields";
import { budgetTokenSymbol, useWalletBudget } from "./token-budget";

// Strategies that can place more than one order, so their budget is the amount per order times the count.
const REPEATING: ReadonlySet<string> = new Set(["dca", "private_payments", "buy_the_dip", "meme_hunter"]);

/**
 * The budget to use, derived on every render: the one the instructions imply until the user picks a budget
 * themselves, then theirs, with a link to the implied one when they differ. Nothing is stored for the suggestion,
 * so editing or refining the text updates it at once.
 */
export function resolveInstructionBudget(
  suggestion: BudgetSuggestion | null,
  stored: AgentBudgetInput | null,
  touched: boolean,
  onApply: () => void,
): { readonly budget: AgentBudgetInput | null; readonly note: BudgetNote | null } {
  if (!suggestion) {
    return { budget: stored, note: null };
  }
  if (!touched) {
    return { budget: suggestion.budget, note: { text: suggestion.note, onApply: null } };
  }
  const same =
    stored?.assetId === suggestion.budget.assetId && stored.amount.trim() === suggestion.budget.amount;
  return same
    ? { budget: stored, note: null }
    : { budget: stored, note: { text: "Your instructions imply a different budget.", onApply } };
}

/** The mainnet create dialog's budget from its instructions, matched against the wallet's own tokens. */
export function useInstructionBudget(
  pack: string,
  text: string,
  stored: AgentBudgetInput | null,
  touched: boolean,
  onApply: () => void,
): { readonly budget: AgentBudgetInput | null; readonly note: BudgetNote | null } {
  const tokens = useWalletBudget().data?.tokens ?? [];
  const suggestion = suggestBudget(
    parseBudgetHint(text, REPEATING.has(pack)),
    tokens.map((token) => ({
      assetId: token.assetId,
      symbol: budgetTokenSymbol(token),
      decimals: token.decimals,
      availableUnits: token.availableUnits,
    })),
  );
  return resolveInstructionBudget(suggestion, stored, touched, onApply);
}
