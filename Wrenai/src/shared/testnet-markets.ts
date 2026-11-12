/** Only these public observations may reuse the existing mainnet market UI in testnet. */
export function testnetMarketRead(path: string): string | null {
  const url = new URL(path, "https://wrenai.invalid");
  if (url.pathname === "/api/trading/spot-markets") {
    return `/api/testnet/markets?view=${url.searchParams.get("view") === "metrics" ? "metrics" : "spot"}`;
  }
  if (url.pathname === "/api/trading/perps-markets") {
    return "/api/testnet/markets?view=perps";
  }
  if (url.pathname === "/api/trading/memecoins") {
    return `/api/testnet/markets?view=memecoins&sort=${encodeURIComponent(url.searchParams.get("sort") ?? "mcap")}`;
  }
  if (url.pathname === "/api/portfolio/insights") {
    return `/api/testnet/markets?view=insights&card=${encodeURIComponent(url.searchParams.get("card") ?? "")}`;
  }
  return null;
}
