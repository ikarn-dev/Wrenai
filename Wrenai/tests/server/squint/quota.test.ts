import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeSquintQuota } from "@/server/squint/quota";

const io = vi.hoisted(() => ({ connection: vi.fn(), eval: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/squint/cache", () => ({ squintRedis: io.connection }));
beforeEach(() => {
  vi.resetAllMocks();
  io.connection.mockReturnValue({ eval: io.eval });
});
describe("shared atomic Squint quota transport", () => {
  it("requires a valid atomic reservation and distinguishes a limit from an outage", async () => {
    io.eval
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce("1")
      .mockRejectedValueOnce(new Error("Offline Redis"));
    expect(await consumeSquintQuota(true)).toBe("allowed");
    expect(await consumeSquintQuota(false)).toBe("limited");
    expect(await consumeSquintQuota(true)).toBe("unavailable");
    expect(await consumeSquintQuota(true)).toBe("unavailable");
    const first = io.eval.mock.calls[0];
    expect(first?.[1]).toEqual(["wrenai:{squint}:requests:v1", "wrenai:{squint}:scans:v1"]);
    expect(first?.[2]?.[0]).toBe("1");
    expect(io.eval.mock.calls[1]?.[2]?.[0]).toBe("0");
    expect(new Set(io.eval.mock.calls.map((call) => call[2]?.[1])).size).toBe(4);
  });
  it("does not bypass a missing shared limiter with process-local permissions", async () => {
    io.connection.mockReturnValue(null);
    expect(await consumeSquintQuota(true)).toBe("unavailable");
    expect(io.eval).not.toHaveBeenCalled();
  });
});
