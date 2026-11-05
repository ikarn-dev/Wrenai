import { z } from "zod";
import { tradingDecimalSchema } from "./manual-trading";
import { type TradeSize, tradeSizeSchema } from "./trade-size";
import { WALLET_SWAP_NATIVE_OUTPUT, WALLET_SWAP_USDC } from "./wallet-swap";

const hint = z
  .string()
  .min(1)
  .max(180)
  .regex(/^(?:native:near|(?:nep141:)?[a-z0-9][a-z0-9._-]*)$/i);
export const chatSpotQuoteSchema = z.strictObject({
  inputToken: hint,
  outputToken: hint,
  amount: tradingDecimalSchema,
});
export const chatQuoteRequestSchema = chatSpotQuoteSchema.extend({ requestId: z.uuid() });
export type ChatQuoteRequest = z.infer<typeof chatQuoteRequestSchema>;
export type DirectWalletQuote = Omit<ChatQuoteRequest, "requestId" | "amount"> & { amount: TradeSize };
function normalizeTradeMessage(message: string): string {
  return message
    .trim()
    .replace(
      /^(?:(?:yes|yeah|ok(?:ay)?|sure)\b[\s,!.]*|please\b[\s,!.]*|give me\b[\s,]*|i (?:want|would like)(?: to)?\s+|(?:can|could|would|will) you(?: please)?\s+){0,5}/i,
      "",
    );
}

/** A safeguard against extraction silently replacing an explicit balance-relative instruction with a fixed amount. */
export function hasRelativeTradeSize(message: string): boolean {
  return /\b(?:all|entire|whole|full|max|remaining|rest of|half|quarter|third|one[- ]third)\s+(?:(?:of|the|my|our|available|unallocated)\s+)*[a-z]|\d\s*(?:%|percent)\s+(?:of\b|my\b)|\b(?:leave|keep)\s+\d[\d.]*\s+\S/i.test(
    message.replace(/\band (?:a |one )?half\b/gi, ""),
  );
}

const walletLocation = String.raw`(?:in|from|using|out of)\s+(?:(?:my|the|connected|near)\s+){0,4}wallet`;
const walletSpotRequest = new RegExp(
  String.raw`^(?:quote|swap|exchange|sell|convert)\s+(?<size>all|half|\d+(?:\.\d+)?%?)\s+(?:of\s+)?(?:my\s+)?(?<pay>[a-z0-9:._-]+)(?<before>\s+${walletLocation})?\s+(?:to|for|into)\s+(?<receive>[a-z0-9:._-]+)(?<after>\s+${walletLocation})?$`,
  "i",
);

function isNativeNearToken(token: string): boolean {
  return /^(?:near|native near|native:near)$/i.test(token.trim());
}

export function isNativePayoutPair(pay: string, receive: string): boolean {
  const token = pay.trim().toLowerCase();
  return (
    isNativeNearToken(receive) &&
    (token === "usdc" ||
      token === "usd coin" ||
      token === "us dollar coin" ||
      token === WALLET_SWAP_USDC ||
      token === WALLET_SWAP_USDC.slice(7))
  );
}

/** Quote only a complete wallet request, including pairs with a single supported funding source. */
export function parseWalletBalanceQuote(message: string, walletConfirmed = false): DirectWalletQuote | null {
  const text = normalizeTradeMessage(message.normalize("NFKC"))
    .replace(/[.!?]+$/, "")
    .replace(/\bnative near\b/gi, WALLET_SWAP_NATIVE_OUTPUT)
    .replace(/\bwrapped near\b/gi, "wnear")
    .replace(/\b(?:usd|us dollar) coin\b/gi, "usdc");
  const match = walletSpotRequest.exec(text)?.groups;
  if (!match) {
    return null;
  }
  const { size, pay, receive, before, after } = match;
  if (!size || !pay || !receive) {
    return null;
  }
  if (!walletConfirmed && !before && !after && !isNativeNearToken(pay) && !isNativePayoutPair(pay, receive)) {
    return null;
  }
  const share = size.toLowerCase();
  const percentage = /^(\d{1,3})(?:\.(\d{1,9}))?%$/.exec(share);
  const decimals = percentage?.[2] ?? "";
  const amount = tradeSizeSchema.safeParse(
    share === "all" || share === "half"
      ? { kind: "fraction", numerator: "1", denominator: share === "all" ? "1" : "2" }
      : percentage
        ? {
            kind: "fraction",
            numerator: BigInt(`${percentage[1]}${decimals}`).toString(),
            denominator: `100${"0".repeat(decimals.length)}`,
          }
        : size,
  );
  const input = hint.safeParse(pay),
    output = hint.safeParse(receive);
  return input.success && output.success && amount.success
    ? { inputToken: input.data, outputToken: output.data, amount: amount.data }
    : null;
}

/** Accept only an entire, unambiguous exact-input request. Extra controls go through verified extraction. */
export function parseExactSpotQuote(message: string): z.infer<typeof chatSpotQuoteSchema> | null {
  const match =
    /^(?:quote|swap|exchange|sell)\s+(\d+(?:\.\d+)?)\s+([a-z0-9:._-]+)\s+(?:to|for|into)\s+([a-z0-9:._-]+)\??$/i.exec(
      normalizeTradeMessage(message),
    );
  const parsed = chatSpotQuoteSchema.safeParse({
    amount: match?.[1],
    inputToken: match?.[2],
    outputToken: match?.[3],
  });
  return parsed.success ? parsed.data : null;
}
export function isManualTradeRequest(message: string): boolean {
  if (
    /\b(?:agents?|automate|automation|every|daily|weekly|recurring|schedule|when|if|bots?|explain|examples?|code|strategy|analy[sz]e|analysis|recommend|should|compare)\b/i.test(
      message,
    ) ||
    /\b(?:do not|don't|never|cancel|stop)\s+(?:(?:this|that|my|the)\s+)?(?:swap|exchange|buy|sell|quote|preview|trade|order|open|close|reduce|long|short)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  const text = normalizeTradeMessage(message.normalize("NFKC")).replace(
    /^(?:i['’]d like to|(?:can|could|may) i|help me|let['’]s|i need to)\s+/i,
    "",
  );
  const size =
    /\b\d+(?:\.\d+)?\s+[a-z][a-z0-9._:-]*\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:and\s+)?[a-z]/i.test(
      text,
    ) || hasRelativeTradeSize(text);
  return (
    /^(?:swap|exchange|convert|buy|sell|open|close|reduce|long|short)\b/i.test(text) ||
    (size && /^(?:turn|change|move|switch|use|trade)\b[\s\S]*\b(?:into|for|buy|to)\b/i.test(text)) ||
    /^(?:get|i want|i['’]d like)\b[\s\S]*\b(?:using|with|for|in exchange for)\b/i.test(text) ||
    /^(?:(?:get|show|find|request|check)(?: me)?\s+)?(?:(?:a|the|fresh|current|new|swap|trade)\s+){0,3}(?:quote|preview)\b/i.test(
      text,
    ) ||
    /^what(?:['’]s| is|s)\s+(?:the\s+)?(?:quote|swap rate)\b/i.test(text) ||
    (/^(?:how much|what (?:would|will|could|do))\b/i.test(text) &&
      size &&
      /\b(?:for|to|into|in|receive|get)\b/i.test(text))
  );
}
