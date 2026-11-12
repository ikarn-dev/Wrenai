import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TestnetError } from "@/server/testnet/config";
import { testnetFailure } from "@/server/testnet/http";
import { TestnetRpcError } from "@/server/testnet/rpc";

describe("testnet HTTP error states", () => {
  it("reports pool funding as an actionable conflict rather than a provider outage", async () => {
    const response = testnetFailure(new TestnetError("funding_required", "Fund the testnet guest pool."));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: "funding_required",
      message: "Fund the testnet guest pool.",
    });
  });
  it("keeps actual RPC outages unavailable and does not claim a transfer happened", async () => {
    const response = testnetFailure(new TestnetRpcError("query", null));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "unavailable",
      message: "Could not load testnet data. Try again shortly.",
    });
  });
});
