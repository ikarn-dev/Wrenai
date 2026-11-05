import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readPerpsMarkFrame } from "@/components/trading/perps-mark-feed";

function frame(changes: unknown): string {
  return JSON.stringify({
    channel: "fastAssetCtxs",
    data: deflateRawSync(JSON.stringify(changes)).toString("base64"),
  });
}

describe("display-only Hyperliquid marks", () => {
  it("uses decimal marks for main-venue markets without applying missing or invalid deltas", async () => {
    const marks = await readPerpsMarkFrame(
      frame({
        BTC: { markPx: "97500.5" },
        ETH: { markPx: "0" },
        SOL: {},
        "xyz:NVDA": { markPx: "145.2" },
        "@107": { markPx: "2.2" },
      }),
    );
    expect([...(marks ?? [])]).toEqual([["BTC", "97500.5"]]);
  });

  it("ignores subscription acknowledgements and rejects oversized decoded frames", async () => {
    await expect(readPerpsMarkFrame('{"channel":"subscriptionResponse"}')).resolves.toBeNull();
    await expect(readPerpsMarkFrame(frame({ BTC: { other: "x".repeat(512_001) } }))).rejects.toThrow(
      "size limit",
    );
  });
});
