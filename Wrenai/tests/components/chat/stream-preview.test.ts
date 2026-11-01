import { describe, expect, it, vi } from "vitest";
import { createStreamPreview } from "@/components/chat/stream-preview";

function frames() {
  let next = 0;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    requestAnimationFrame(callback: FrameRequestCallback): number {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number): void {
      pending.delete(id);
    },
    draw(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    },
    pending,
  };
}

describe("chat preview painting", () => {
  it("paints a burst once per frame and preserves every chunk in order", () => {
    const scheduler = frames();
    const render = vi.fn();
    const preview = createStreamPreview(render, scheduler);
    for (let i = 0; i < 100; i++) {
      preview.append(`${i} `);
    }
    expect(render).not.toHaveBeenCalled();
    expect(scheduler.pending.size).toBe(1);
    scheduler.draw();
    expect(render).toHaveBeenCalledExactlyOnceWith(Array.from({ length: 100 }, (_, i) => `${i} `).join(""));
    preview.append("next");
    scheduler.draw();
    expect(render.mock.lastCall?.[0]).toMatch(/99 next$/);
  });

  it("clears a superseded attempt without painting its scheduled text", () => {
    const scheduler = frames();
    const render = vi.fn();
    const preview = createStreamPreview(render, scheduler);
    preview.append("superseded");
    preview.reset();
    scheduler.draw();
    expect(render).toHaveBeenCalledExactlyOnceWith("");
    preview.append("replacement");
    scheduler.draw();
    expect(render.mock.lastCall?.[0]).toBe("replacement");
  });

  it("cannot paint after stopping, navigating away or receiving the saved reply", () => {
    const scheduler = frames();
    const render = vi.fn();
    const preview = createStreamPreview(render, scheduler);
    preview.append("provisional");
    const delayed = [...scheduler.pending.values()][0];
    preview.dispose();
    delayed?.(0);
    preview.append("late chunk");
    preview.reset();
    scheduler.draw();
    expect(render).not.toHaveBeenCalled();
    expect(scheduler.pending.size).toBe(0);
  });
});
