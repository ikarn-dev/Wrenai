import { multiplyDecimal, parseBudgetHint } from "@/shared/budget-hint";

// Pure checks on a rewrite against the user's own text, with no AI. A rewrite may restate and complete the user's
// instructions; it may not rename a token, drop a contract or change an amount.

// A NEAR account or token contract (usdt.tether-token.near, eth.tidepool-sandbox.testnet) or a 64-hex implicit one.
const CONTRACT = /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b|\b[0-9a-f]{64}\b/gi;
// Ticker-shaped words: USDC, NEAR, wNEAR, ETH, XAUT.
const TICKER = /\b[a-z]?[A-Z][A-Z0-9]{1,9}\b/g;
// Words a rewrite may use that are not tokens.
const NOT_TOKENS = new Set(["usd", "utc", "am", "pm", "dca", "tp", "sl", "ok"]);

function contracts(text: string): string[] {
  return [...text.matchAll(CONTRACT)].map((match) => match[0].toLowerCase());
}

/** Every number in the text as written, for checking that an exact amount survived. */
function numbers(text: string): Set<string> {
  return new Set([...text.matchAll(/(?<![\d.])\d+(?:\.\d+)?/g)].map((match) => match[0]));
}

/**
 * What the rewrite got wrong, as short fixes to send back to the model, or an empty list. `extraTokens` are names
 * the rewrite may add, such as the selected budget token.
 */
export function rewriteProblems(original: string, refined: string, extraTokens: readonly string[]): string[] {
  const problems: string[] = [];
  const source = original.toLowerCase(),
    allowed = new Set(extraTokens.map((name) => name.toLowerCase()));
  const kept = new Set(contracts(refined));
  for (const contract of contracts(original)) {
    if (!kept.has(contract)) {
      problems.push(`Keep the token contract ${contract} exactly as written.`);
    }
  }
  for (const [ticker] of refined.matchAll(TICKER)) {
    const name = ticker.toLowerCase();
    if (!NOT_TOKENS.has(name) && !allowed.has(name) && !new RegExp(`\\b${name}\\b`, "i").test(source)) {
      problems.push(`Don't rename tokens: the user never wrote ${ticker}. Use their token names exactly.`);
    }
  }
  const before = parseBudgetHint(original, true),
    after = parseBudgetHint(refined, true);
  if (before?.amount && after?.amount && before.symbol.toLowerCase() === after.symbol.toLowerCase()) {
    const totals = new Set([before.amount]);
    if (before.perOrder && before.count !== null) {
      totals.add(multiplyDecimal(before.perOrder, before.count));
    }
    if (!totals.has(after.amount)) {
      problems.push(`Keep the total at exactly ${before.amount} ${before.symbol}.`);
    }
  }
  if (
    before?.perOrder &&
    before.count !== null &&
    before.count > 1 &&
    !numbers(refined).has(before.perOrder)
  ) {
    problems.push(`State exactly ${before.perOrder} ${before.symbol} per order, not a rounded figure.`);
  }
  return [...new Set(problems)];
}
