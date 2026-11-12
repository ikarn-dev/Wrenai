import { nearAccountSchema } from "./agent-budget";
import { paymentAmountSchema } from "./chat-payment";

export interface ChatPayment {
  readonly amount: string;
  readonly token: string;
  readonly recipient: string;
  readonly route: "private" | "wallet" | null;
}

export type PaymentRequest = ChatPayment | { readonly issue: string };

const GREETING = /^(?:(?:hey|hi|hello)\b(?:[\s,.:!?–—]+jarvis\b)?|jarvis\b)[\s,.:!?–—]+/;
const LEAD =
  /^(?:(?:please|now|can you|could you|would you|will you|can i|i want to|i need to|i['’]d like to|i would like to|help me|go ahead and|let['’]s)\s+)*/;
const VERB = `(?:send(?: over)?|resend|pay(?: out)?|transfer|give|gift|tip|forward|wire|remit|reimburse|refund|move|(?:make|prepare|initiate|issue) (?:a )?(?:payment|transfer)(?: of)?)`;
const COMMAND = new RegExp(`^${VERB}(?= |$)`);
const RETRY = new RegExp(
  `^(?:(?:try to )?${VERB}(?: (?:it|that|the payment|the transfer))? again|retry (?:the )?(?:payment|transfer)|resend(?: it| that| the payment)?)$`,
);
const MODIFIER =
  /(?<!\S)(?:(?<private>privately|confidentially|as a (?:private|confidential) payment|(?:from|using|via|with) (?:(?:my|the) )?(?:private|confidential)(?: balance| wallet)?)|(?<wallet>publicly|on[- ]chain|as a public payment|(?:from|using|via|with) (?:(?:my|the) )?(?:connected |public )?(?:near )?wallet)|on near(?: mainnet)?|please|right now|now)(?!\S)/g;
const OTHER_NETWORK =
  /(?<!\S)(?:on|via|using) (?:the )?(?:near testnet|testnet|solana|ethereum|eth mainnet|base|arbitrum|bitcoin|polygon|bsc|avalanche)(?!\S)/;
const SCHEDULE =
  /(?<!\S)(?:every|tomorrow|tonight|later|daily|weekly|monthly|when|if|once|then|unless|schedule|scheduled|recurring|next (?:day|week|month)|in \d+ (?:seconds?|minutes?|hours?|days?)|at \d{1,2}(?::\d{2})?(?: ?[ap]m)?)(?!\S)/;
const MONEY =
  /(?<!\S)(?:payment|transfer|funds?|money|crypto|tokens?|near|wnear|usdc|usdt|wallet|balance|nep141:[^\s]+)(?!\S)|\bto (?:`?@?[a-z0-9_-]+\.[a-z0-9._-]+|(?:near )?(?:wallet|account|address) )/;
const ACCOUNT_ID = `@?[a-z0-9._-]+`;
const ACCOUNT_LABEL = `(?:the )?(?:near )?(?:account(?: id)?|wallet|address) `;
const ACCOUNT_START = new RegExp(`^${ACCOUNT_LABEL}`);
const ACCOUNT = String.raw`(?:${ACCOUNT_LABEL})?(?:\x60${ACCOUNT_ID}\x60|${ACCOUNT_ID})`;
const TO_ACCOUNT = new RegExp(`^(?:(?<funds>.+?) )?(?:over )?(?:to|into|for) (?<account>${ACCOUNT})$`);
const ACCOUNT_FIRST = new RegExp(
  `^(?:to )?(?<account>${ACCOUNT}) (?:for |with |an amount of )?(?<funds>.+)$`,
);
const ACCOUNT_LAST = new RegExp(`^(?<funds>.+) (?<account>${ACCOUNT})$`);
const TOKEN_NAME = String.raw`(?:native near|wrapped near|usd coin|\$?[a-z][a-z0-9:._-]*|[0-9]+[a-z][a-z0-9:._-]*)`;
const TOKEN = String.raw`(?:\x60${TOKEN_NAME}\x60|${TOKEN_NAME})`;
const AMOUNT_FIRST = new RegExp(
  `^(?<amount>.+?) (?<possessive>(?:of )?my |of )?(?<token>${TOKEN})(?: tokens?)?$`,
);
const TOKEN_FIRST = new RegExp(`^(?<token>${TOKEN})(?: tokens?)? (?<amount>.+)$`);
const TOKEN_ONLY = new RegExp(`^${TOKEN}(?: tokens?)?$`);
const INFORMATION =
  /^(?:(?:me|us) )?(?:[a-z]+ |\d+ )?(?:(?:latest|current|recent|live|near|usdc) )*(?:advice|analysis|articles?|attention|charts?|data|details|emails?|examples?|fees?|files?|ideas|images?|info(?:rmation)?|links?|lists?|messages?|news|photos?|prices?|recommendations?|reports?|screenshots?|summar(?:y|ies)|tips?|videos?|ways)\b/;
const SMALL =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const SCALE = new Map([
  ["billion", 1_000_000_000n],
  ["million", 1_000_000n],
  ["thousand", 1_000n],
]);
const FRACTIONS = new Map([
  ["half", "5"],
  ["a half", "5"],
  ["half a", "5"],
  ["half an", "5"],
  ["1/2", "5"],
  ["a quarter", "25"],
  ["quarter", "25"],
  ["1/4", "25"],
  ["three quarters", "75"],
  ["3/4", "75"],
]);
const EXACT_AMOUNT = "Use one exact token amount. For example, send 1 USDC to alice.near.";
const EXACT_ACCOUNT = "Which NEAR account should receive the payment? Enter its exact account ID.";

function paymentText(message: string): string {
  return message
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(GREETING, "")
    .replace(/,\s+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

function belowHundred(text: string): bigint | null {
  const [first, ...rest] = text.split(" ");
  const ones = first === undefined ? -1 : SMALL.indexOf(first);
  const tens = first === undefined ? -1 : TENS.indexOf(first);
  if (!rest.length && ones >= 0) {
    return BigInt(ones);
  }
  if (tens >= 0 && rest.length <= 1) {
    const digit = rest[0] === undefined ? 0 : SMALL.indexOf(rest[0]);
    return digit >= 0 && digit <= 9 ? BigInt(tens + 2) * 10n + BigInt(digit) : null;
  }
  return null;
}

function belowThousand(text: string): bigint | null {
  const [lead, tail, extra] = text.split(" hundred");
  if (lead === undefined || tail === undefined) {
    return belowHundred(text);
  }
  const first = SMALL.indexOf(lead);
  const rest = tail === "" ? 0n : tail.startsWith(" ") ? belowHundred(tail.replace(/^ (?:and )?/, "")) : null;
  return first > 0 && first <= 9 && rest !== null && extra === undefined ? BigInt(first) * 100n + rest : null;
}

function wholeWords(text: string): bigint | null {
  const parts = text.replaceAll("-", " ").split(/ (billion|million|thousand)\b ?/);
  let total = 0n;
  let previous = 1_000_000_000_000n;
  for (let index = 0; index < parts.length; index += 2) {
    const words = index > 0 ? parts[index]?.replace(/^and /, "") : parts[index];
    const scale = parts[index + 1];
    const value = words ? belowThousand(words) : total > 0n && scale === undefined ? 0n : null;
    const multiplier = scale === undefined ? 1n : SCALE.get(scale);
    if (value === null || multiplier === undefined || multiplier >= previous || (scale && value === 0n)) {
      return null;
    }
    total += value * multiplier;
    previous = multiplier;
  }
  return total;
}

function exactAmount(raw: string): string | null {
  const text = raw.replace(/^`([^`]*)`$/, "$1");
  if (/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/.test(text)) {
    return text
      .replaceAll(",", "")
      .replace(/^\./, "0.")
      .replace(/^0+(?=\d)/, "");
  }
  if (text === "a" || text === "an") {
    return "1";
  }
  const fraction = FRACTIONS.get(text);
  if (fraction) {
    return `0.${fraction}`;
  }
  const [whole, suffix] = text.split(/ and (?:a )?half$/);
  if (whole && suffix !== undefined) {
    const integer = wholeWords(whole);
    return integer === null ? null : `${integer}.5`;
  }
  const { integerWords, decimalWords } =
    /^(?:(?<integerWords>.+) )?point (?<decimalWords>.+)$/.exec(text)?.groups ?? {};
  if (decimalWords) {
    const integer = integerWords ? wholeWords(integerWords) : 0n;
    const digits = decimalWords.split(" ").map((digit) => {
      const value = SMALL.indexOf(digit);
      return value >= 0 && value < 10 ? String(value) : /^[0-9]+$/.test(digit) ? digit : null;
    });
    return integer !== null && digits.every((digit) => digit !== null)
      ? `${integer}.${digits.join("")}`
      : null;
  }
  return wholeWords(text)?.toString() ?? null;
}

function paymentFunds(text: string): { amount: string; token: string } | null {
  const candidates = [AMOUNT_FIRST, TOKEN_FIRST].flatMap((pattern) => {
    const { amount: quantity, token: name, possessive } = pattern.exec(text)?.groups ?? {};
    if (!quantity || !name) {
      return [];
    }
    const amount = paymentAmountSchema.safeParse(exactAmount(quantity));
    const token = name.replace(/^`|`$/g, "");
    if (
      !amount.success ||
      (possessive && amount.data.includes(".")) ||
      /^(?:usd|dollars?|cents|eur|euros?|gbp|pounds?)$/.test(token)
    ) {
      return [];
    }
    return [{ amount: amount.data, token }];
  });
  const [first, second] = candidates;
  return first && (!second || (first.amount === second.amount && first.token === second.token))
    ? first
    : null;
}

function recipientAccount(text: string): string | null {
  const raw = text.replace(ACCOUNT_START, "");
  const explicit = raw !== text || raw.startsWith("`");
  const candidate = raw.replace(/^`|`$/g, "");
  const parsed = nearAccountSchema.safeParse(candidate.replace(/^@/, ""));
  if (!parsed.success) {
    return null;
  }
  if (/^0x[0-9a-f]{40}$/.test(parsed.data)) {
    return /^(?:the )?near /.test(text) ? parsed.data : null;
  }
  return (/[a-z]/.test(parsed.data) && parsed.data.includes(".")) ||
    /^[a-f0-9]{64}$/.test(parsed.data) ||
    (explicit && !candidate.startsWith("@"))
    ? parsed.data
    : null;
}

function paymentDetails(details: string, route: ChatPayment["route"]): PaymentRequest | null {
  for (const pattern of [TO_ACCOUNT, ACCOUNT_FIRST, ACCOUNT_LAST]) {
    const { account, funds: description = "" } = pattern.exec(details)?.groups ?? {};
    if (!account) {
      continue;
    }
    const funds = paymentFunds(description);
    const recipient = recipientAccount(account);
    if (!recipient && (funds || pattern === TO_ACCOUNT)) {
      return { issue: EXACT_ACCOUNT };
    }
    if (funds && recipient) {
      return { ...funds, recipient, route };
    }
    if (pattern === TO_ACCOUNT) {
      if (paymentAmountSchema.safeParse(exactAmount(description)).success) {
        return { issue: "Which token should I send?" };
      }
      return { issue: TOKEN_ONLY.test(description) ? "How much should I send?" : EXACT_AMOUNT };
    }
  }
  return paymentFunds(details) ? { issue: EXACT_ACCOUNT } : null;
}

export function parseChatPayment(
  message: string,
  network: "mainnet" | "testnet" = "mainnet",
): PaymentRequest | null {
  if (network === "testnet" && /\bon (?:near )?mainnet\b/i.test(message)) {
    return { issue: "This session uses NEAR Testnet. Switch networks for a mainnet payment." };
  }
  const text = paymentText(
    network === "testnet" ? message.replace(/\bon (?:near )?testnet\b/gi, "") : message,
  );
  const modifiers = [...text.matchAll(MODIFIER)];
  const privateRoute = modifiers.some(({ groups: { private: modifier } = {} }) => Boolean(modifier));
  const walletRoute = modifiers.some(({ groups: { wallet: modifier } = {} }) => Boolean(modifier));
  const plain = text.replace(MODIFIER, " ").trim().replace(/ +/g, " ").replace(LEAD, "");
  const command = COMMAND.exec(plain);
  if (!command) {
    return null;
  }
  const details = plain.slice(command[0].length).trim();
  const asksForInformation = INFORMATION.test(details);
  if (asksForInformation && /^(?:a|an|the) /.test(details)) {
    return null;
  }
  const route = privateRoute ? "private" : walletRoute ? "wallet" : null;
  const parsed = paymentDetails(details, route);
  if (!parsed || "issue" in parsed) {
    if (asksForInformation || (details && !MONEY.test(text) && !privateRoute && !walletRoute)) {
      return null;
    }
  }
  if (SCHEDULE.test(plain)) {
    return {
      issue:
        network === "testnet"
          ? "For a scheduled payment, open the public Payments agent setup."
          : "For a scheduled or conditional payment, open the Private Payments agent setup.",
    };
  }
  if (OTHER_NETWORK.test(text)) {
    return { issue: `Payments here use NEAR ${network}. Enter a NEAR recipient and a token on NEAR.` };
  }
  if (privateRoute && walletRoute) {
    return { issue: "Choose one payment route. Private or Public wallet." };
  }
  return parsed ?? { issue: EXACT_AMOUNT };
}

export function isPaymentRetry(message: string): boolean {
  return RETRY.test(paymentText(message).replace(LEAD, ""));
}
