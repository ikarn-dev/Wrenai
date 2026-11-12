/**
 * Reads the budget a user's own instructions imply, locally and without AI: the token spent, the amount per order,
 * how many orders, and an explicit total. Display help only: the verified strategy parse remains the authority, and
 * the user can change the budget. Unclear text gives no hint rather than a guess.
 */
export interface BudgetHint {
  readonly symbol: string;
  /** The total to allocate as an exact decimal string, or null when the count can't be read. */
  readonly amount: string | null;
  /** The amount each order spends, when the instructions state it or it divides exactly enough to show. */
  readonly perOrder: string | null;
  /** How many orders, when the instructions say. */
  readonly count: number | null;
  /** Where the instructions say the funds come from ("from my wallet"), when they say so (testnet balances). */
  readonly location: "wallet" | "intents" | null;
  /** How the amount was worked out, for the note beside the budget. */
  readonly basis: string | null;
}

const NUMBER = String.raw`(\d{1,30}(?:\.\d{1,36})?)`;
// A ticker (USDC, wNEAR) or a NEAR contract (usdt.tether-token.near).
const TOKEN = "([A-Za-z$][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*)";
const SPEND = new RegExp(
  String.raw`\b(?:spend|sell|send|pay|swap|use|invest|convert)\s+${NUMBER}\s+${TOKEN}`,
  "i",
);
const WITH = new RegExp(String.raw`\b(?:with|using)\s+${NUMBER}\s+${TOKEN}`, "i");
// "2 USDC in 2 trades", "split into 4 orders": the amount is the total, divided across the orders.
const SPLIT =
  /\b(?:in|into|across|over|split\s+(?:into|across|over|in))\s+(\d{1,5})\s*(?:trades|orders|buys|parts|chunks|swaps|payments|purchases|sells|tranches)\b/i;
// "DCA 0.5 USDC into ETH", "Buy 1 USDC of ETH", "Put 2 USDT into wBTC".
const INTO = new RegExp(
  String.raw`\b(?:dca|put|buy|allocate)\s+${NUMBER}\s+${TOKEN}\s+(?:of|worth\s+of|into|in|on|to\s+buy)\b`,
  "i",
);
// "0.5 USDC every minute", with no verb before it; "buy 0.1 ETH every day" names what is bought, not spent.
const EACH = new RegExp(
  String.raw`(?<!\b(?:buy|get|receive)\s+)(?<![\d.])${NUMBER}\s+${TOKEN}\s+(?:every|each|per|a|an)\b`,
  "i",
);
const TOTAL = new RegExp(
  String.raw`\b(?:budget(?:\s+of)?|total(?:\s+of)?|up\s+to|at\s+most|max(?:imum)?(?:\s+of)?)\s+${NUMBER}\s+${TOKEN}`,
  "i",
);
const TOTAL_AFTER = new RegExp(String.raw`${NUMBER}\s+${TOKEN}\s+(?:in\s+total|total)\b`, "i");
const TIMES = /\b(\d{1,5})\s*(?:times|orders|trades|swaps|buys|purchases|payments|sells|rounds|runs)\b/i;
const EVERY =
  /\bevery\s+(\d+(?:\.\d+)?)?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i;
const FOR =
  /\b(?:for|over|stop\s+after|ending\s+after)\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i;
const WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};
// Words that look like a token after a number but are units of time or count.
const NOT_TOKENS = new Set([
  "times",
  "orders",
  "trades",
  "seconds",
  "minutes",
  "hours",
  "days",
  "weeks",
  "percent",
  "bps",
]);
const MAX_ORDERS = 100_000;

function seconds(value: string | undefined, unit: string): number {
  const amount = value === undefined ? 1 : (WORDS[value.toLowerCase()] ?? Number(value)),
    u = unit.toLowerCase();
  const scale = u.startsWith("w")
    ? 604_800
    : u.startsWith("d")
      ? 86_400
      : u.startsWith("h")
        ? 3600
        : u.startsWith("m")
          ? 60
          : 1;
  return amount * scale;
}

/**
 * An exact decimal divided by a whole count, rounded down to `digits` decimals so the orders never add up to more
 * than the total. Null when that rounds to zero.
 */
export function divideDecimal(value: string, count: number, digits: number): string | null {
  const [whole = "0", fraction = ""] = value.split(".");
  const scaled = BigInt(`${whole}${fraction.padEnd(digits, "0").slice(0, digits)}`) / BigInt(count);
  if (scaled === 0n) {
    return null;
  }
  const text = scaled.toString().padStart(digits + 1, "0");
  const head = text.slice(0, text.length - digits),
    tail = text.slice(text.length - digits).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

/** An exact decimal times a whole count, without floating point. */
export function multiplyDecimal(value: string, count: number): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const scaled = BigInt(`${whole}${fraction}`) * BigInt(count),
    text = scaled.toString().padStart(fraction.length + 1, "0");
  if (fraction.length === 0) {
    return text;
  }
  const head = text.slice(0, -fraction.length),
    tail = text.slice(-fraction.length).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

function orderCount(
  text: string,
  repeats: boolean,
): { readonly count: number; readonly basis: string } | null {
  if (!repeats || /\bonce\b/i.test(text)) {
    return { count: 1, basis: "one order" };
  }
  if (/\btwice\b/i.test(text)) {
    return { count: 2, basis: "2 orders" };
  }
  const times = TIMES.exec(text);
  if (times?.[1]) {
    const count = Number(times[1]);
    return count >= 1 && count <= MAX_ORDERS ? { count, basis: `${count} orders` } : null;
  }
  const every = EVERY.exec(text),
    span = FOR.exec(text);
  if (every?.[2] && span?.[1] && span[2]) {
    const interval = seconds(every[1], every[2]),
      count = Math.floor(seconds(span[1], span[2]) / interval);
    return interval > 0 && count >= 1 && count <= MAX_ORDERS ? { count, basis: `${count} orders` } : null;
  }
  return null;
}

/** "007.50" → "7.5": the canonical form budgets accept; null for zero. */
function canonical(value: string): string | null {
  const [whole = "0", fraction = ""] = value.split(".");
  const head = whole.replace(/^0+(?=\d)/, ""),
    tail = fraction.replace(/0+$/, "");
  const text = tail ? `${head}.${tail}` : head;
  return /^0(?:\.0*)?$/.test(text) ? null : text;
}

function token(match: RegExpExecArray | null): { readonly amount: string; readonly symbol: string } | null {
  const amount = match?.[1] ? canonical(match[1]) : null,
    symbol = match?.[2];
  return amount && symbol && !NOT_TOKENS.has(symbol.toLowerCase()) && !symbol.startsWith("$")
    ? { amount, symbol }
    : null;
}

/**
 * `repeats` is true for strategies that place more than one order (DCA); the others spend their amount once.
 * A stated total wins over amount × count.
 */
export function parseBudgetHint(text: string, repeats: boolean): BudgetHint | null {
  const spend =
      token(SPEND.exec(text)) ?? token(WITH.exec(text)) ?? token(INTO.exec(text)) ?? token(EACH.exec(text)),
    total = token(TOTAL.exec(text)) ?? token(TOTAL_AFTER.exec(text));
  // Only where the funds come from; "receive in my wallet" names the output, not the budget.
  const location = /\bfrom\s+(?:my\s+)?(?:public\s+)?intents\b/i.test(text)
    ? "intents"
    : /\bfrom\s+(?:my\s+)?wallet\b/i.test(text)
      ? "wallet"
      : null;
  if (total && (!spend || total.symbol.toLowerCase() === spend.symbol.toLowerCase())) {
    return {
      symbol: total.symbol,
      amount: total.amount,
      perOrder: spend?.amount ?? null,
      count: null,
      location,
      basis: "the stated total",
    };
  }
  if (!spend) {
    return null;
  }
  // "0.5 USDC per order in 4 orders" states the per-order amount, so it is not a split.
  const perOrderStated = /\b(?:per|each)\s+(?:order|trade|buy|swap|payment|purchase)\b/i.test(text);
  const split = perOrderStated ? 0 : Number(SPLIT.exec(text)?.[1] ?? "0");
  if (split >= 1 && split <= MAX_ORDERS) {
    // Six decimals is the finest stablecoin unit; the verified parse checks the token's own precision.
    const each = divideDecimal(spend.amount, split, 6);
    return {
      symbol: spend.symbol,
      amount: spend.amount,
      perOrder: each,
      count: split,
      location,
      basis: split === 1 ? null : `${split} orders${each ? ` of ${each} ${spend.symbol}` : ""}`,
    };
  }
  const count = orderCount(text, repeats);
  return count
    ? {
        symbol: spend.symbol,
        amount: multiplyDecimal(spend.amount, count.count),
        perOrder: spend.amount,
        count: count.count,
        location,
        basis: count.count === 1 ? null : `${count.basis} × ${spend.amount} ${spend.symbol}`,
      }
    : { symbol: spend.symbol, amount: null, perOrder: spend.amount, count: null, location, basis: null };
}
