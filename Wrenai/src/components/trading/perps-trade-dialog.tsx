"use client";
import type { ReactElement } from "react";
import type { PerpsMarketRow } from "@/shared/market-pages";
import { decimalDisplay } from "@/shared/trading-display";
import { Change } from "./market-cells";
import { fundingDisplay } from "./perps-markets-table";
import { PerpsTicket } from "./perps-ticket";
import { perpsIcon } from "./token-icon";
import { TradeDialog, TradeDialogHeader } from "./trade-dialog";

/** Trading one Perps market: the same popup as Spot and Memecoins, holding the order ticket. */
export function PerpsTradeDialog({
  target,
  onClose,
}: {
  /** The market being traded; null keeps the dialog closed. */
  readonly target: PerpsMarketRow | null;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <TradeDialog open={target !== null} onClose={onClose}>
      {target ? (
        <div key={target.name} className="flex flex-col gap-5">
          <TradeDialogHeader
            symbol={target.name}
            icon={perpsIcon(target.name)}
            title={`Trade ${target.name}`}
            detail={
              <>
                <span className="font-mono tabular-nums">${decimalDisplay(target.mark)}</span>
                <Change value={target.change24h} />
                <span className="font-mono tabular-nums">· {fundingDisplay(target.funding)} 1h</span>
              </>
            }
          />
          <PerpsTicket market={target.name} maxLeverage={target.maxLeverage} />
        </div>
      ) : null}
    </TradeDialog>
  );
}
