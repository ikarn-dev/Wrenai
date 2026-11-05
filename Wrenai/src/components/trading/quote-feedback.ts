import { notify } from "@/components/ui/toast";

const QUOTE_ERRORS = new Map([
  ["insufficient_funds", "Insufficient funds."],
  ["invalid_input", "Check the quote details."],
  ["limit", "Quote exceeds your limits."],
  ["rate_limited", "Too many requests. Try again shortly."],
  ["signed_out", "Sign in to get a quote."],
]);

export function notifyQuoteFailure(code: string): void {
  notify("warn", QUOTE_ERRORS.get(code) ?? "Quote unavailable.");
}
