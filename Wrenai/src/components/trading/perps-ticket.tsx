"use client";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { ActivityIndicator } from "@/components/ui/activity-indicator";
import { Button } from "@/components/ui/button";
import type { ManualPreview } from "@/shared/manual-trading";
import { Segment, SLIPPAGE, UnitField } from "./ticket-fields";
import { TradeCard } from "./trade-card";
import { requestManualQuote } from "./trading-mutations";

type Side = "long" | "short";
type Action = "open" | "reduce" | "close";

const LEVERAGE = [1, 2, 3, 5, 10, 20, 50] as const;
const TRAILING = [
  { value: 0, label: "Off" },
  { value: 100, label: "1%" },
  { value: 200, label: "2%" },
  { value: 500, label: "5%" },
] as const;
/** Hyperliquid venue fees are capped at 0.1% per order. */
const MAXIMUM_FEE_BPS = 10;

/**
 * One isolated-margin order for one market, inside the Perps trade dialog. Review swaps the form for its quote
 * card; nothing is sent until it is confirmed there, and "Change order" returns to the form.
 */
export function PerpsTicket({
  market,
  maxLeverage,
}: {
  readonly market: string;
  readonly maxLeverage: number;
}): ReactElement {
  const leverages = LEVERAGE.filter((value) => value <= maxLeverage);
  const [side, setSide] = useState<Side>("long"),
    [action, setAction] = useState<Action>("open"),
    [quantity, setQuantity] = useState(""),
    [leverage, setLeverage] = useState<number>(Math.min(2, maxLeverage)),
    [margin, setMargin] = useState(""),
    [stop, setStop] = useState(""),
    [target, setTarget] = useState(""),
    [trailing, setTrailing] = useState<number>(0),
    [slippage, setSlippage] = useState<number>(50),
    [quote, setQuote] = useState<ManualPreview | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const result = await requestManualQuote({
        requestId: crypto.randomUUID(),
        source: "perps",
        intent: {
          kind: "perps",
          market,
          side,
          action,
          quantity: quantity.trim(),
          leverage,
          maximumMarginUsd: margin.trim(),
          stopLossPrice: stop.trim() || null,
          takeProfitPrice: target.trim() || null,
          trailingStopBps: trailing === 0 ? null : trailing,
          slippageBps: slippage,
          maximumFeeBps: MAXIMUM_FEE_BPS,
        },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setQuote(result.value);
    });
  }

  if (quote) {
    return (
      <div className="flex flex-col gap-3">
        <TradeCard id={quote.id} initial={quote} onClose={() => setQuote(null)} />
        <button
          type="button"
          onClick={() => setQuote(null)}
          className="self-start rounded-xs text-caption text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong"
        >
          Change order
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} aria-busy={busy} className="flex flex-col gap-4">
      <Segment<Side>
        label="Side"
        value={side}
        onChange={setSide}
        options={[
          { value: "long", label: "Long" },
          { value: "short", label: "Short" },
        ]}
      />
      <Segment<Action>
        label="Action"
        value={action}
        onChange={setAction}
        options={[
          { value: "open", label: "Open" },
          { value: "reduce", label: "Reduce" },
          { value: "close", label: "Close" },
        ]}
      />
      <UnitField label="Size" unit={market} value={quantity} onChange={setQuantity} required />
      <Segment<number>
        label="Leverage"
        value={leverage}
        onChange={setLeverage}
        options={leverages.map((value) => ({ value, label: `${value}×` }))}
      />
      <UnitField label="Max margin" unit="USDC" value={margin} onChange={setMargin} required />
      <div className="grid grid-cols-2 gap-3">
        <UnitField
          label="Stop-loss"
          unit="USD"
          value={stop}
          onChange={setStop}
          placeholder="Price"
          required={action === "open"}
        />
        <UnitField
          label="Take-profit"
          unit="USD"
          value={target}
          onChange={setTarget}
          placeholder="Optional"
        />
      </div>
      <Segment<number> label="Trailing stop" value={trailing} onChange={setTrailing} options={TRAILING} />
      <Segment<number> label="Slippage" value={slippage} onChange={setSlippage} options={SLIPPAGE} />
      {error ? (
        <p role="alert" className="text-caption text-warn">
          {error}
        </p>
      ) : null}
      <div className="grid">
        <Button
          type="submit"
          variant="primary"
          aria-busy={busy}
          disabled={!quantity.trim() || !margin.trim()}
        >
          {busy ? <ActivityIndicator size={18} label="Checking order" /> : "Review order"}
        </Button>
      </div>
    </form>
  );
}
