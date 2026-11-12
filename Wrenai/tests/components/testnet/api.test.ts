import { afterEach, describe, expect, it, vi } from "vitest";
import { testnetApi } from "@/components/testnet/api";

afterEach(() => vi.unstubAllGlobals());
describe("testnet API response handling", () => {
  it("shows the actual funding requirement instead of a generic service error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            ok: false,
            code: "funding_required",
            message: "The guest pool needs native NEAR on testnet before accepting guests.",
          },
          { status: 409 },
        ),
      ),
    );
    await expect(testnetApi({ command: "guest" })).rejects.toThrow("needs native NEAR");
  });
  it("handles HTML 404s and invalid JSON without exposing the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>private server output</html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    await expect(testnetApi()).rejects.toThrow("testnet API was not found");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("private server output", {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(testnetApi()).rejects.toThrow("Could not load testnet");
  });
  it("returns successful data without accepting a failure status as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, data: null })),
    );
    await expect(testnetApi()).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, data: null }, { status: 503 })),
    );
    await expect(testnetApi()).rejects.toThrow("Could not load testnet");
  });
});
