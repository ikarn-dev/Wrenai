import { z } from "zod";
import { tradingDecimalSchema } from "./manual-trading";

const hint = z
  .string()
  .min(1)
  .max(180)
  .regex(/^(?:nep141:)?[a-z0-9][a-z0-9._-]*$/i);
export const chatSpotQuoteSchema = z.strictObject({
  inputToken: hint,
  outputToken: hint,
  amount: tradingDecimalSchema,
});
export const chatQuoteRequestSchema = chatSpotQuoteSchema.extend({ requestId: z.uuid() });
export type ChatQuoteRequest = z.infer<typeof chatQuoteRequestSchema>;
function normalizeTradeMessage(message: string): string {
  return message
    .trim()
    .replace(
      /^(?:(?:yes|yeah|ok(?:ay)?|sure)\b[\s,!.]*|please\b[\s,!.]*|give me\b[\s,]*|i (?:want|would like)(?: to)?\s+|(?:can|could|would|will) you(?: please)?\s+){0,5}/i,
      "",
    );
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
  const text = normalizeTradeMessage(message);
  return (
    /^(?:swap|exchange|buy|sell|open|close|reduce|long|short)\b/i.test(text) ||
    /^(?:(?:get|show|find|request|check)(?: me)?\s+)?(?:(?:a|the|fresh|current|new|swap|trade)\s+){0,3}(?:quote|preview)\b/i.test(
      text,
    ) ||
    /^what(?:['’]s| is|s)\s+(?:the\s+)?(?:quote|swap rate)\b/i.test(text) ||
    (/^(?:how much|what (?:would|will|do) i (?:get|receive))\b/i.test(text) &&
      /\b\d+(?:\.\d+)?\s+[a-z][a-z0-9._:-]*\b/i.test(text) &&
      /\b(?:for|to|into|in|receive|get)\b/i.test(text))
  );
}
