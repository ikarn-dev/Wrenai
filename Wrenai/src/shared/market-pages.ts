import type { ManualBalance, ManualPreview } from "./manual-trading";
import type { TradeAsset } from "./trade-preview";

export interface SpotMarketToken extends TradeAsset {
  readonly price: string | null;
  /** When 1Click last updated the price (epoch ms); its token list is a cached snapshot. */
  readonly priceUpdatedAt: number | null;
}
/** Inline NEP-148 data:image icons by asset ID, NEAR tokens only. Fetched once per session, apart from prices. */
export type TokenIcons = Readonly<Record<string, string>>;
export interface PerpsMarketRow {
  readonly name: string;
  readonly mark: string;
  readonly funding: string;
  readonly maxLeverage: number;
  readonly sizeDecimals: number;
}
export interface ManualAccountView {
  readonly nativeAccountId: string | null;
  readonly perpsAddress: string | null;
  readonly recoveryReady: boolean;
  readonly balances: readonly ManualBalance[];
  readonly balanceNotice: string | null;
  readonly positions: readonly {
    readonly market: string;
    readonly side: "long" | "short";
    readonly quantity: string;
    readonly decimals: number;
  }[];
  readonly orders: readonly ManualPreview[];
}
