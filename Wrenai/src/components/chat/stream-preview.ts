interface PreviewScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

export interface StreamPreview {
  readonly append: (text: string) => void;
  readonly reset: () => void;
  readonly dispose: () => void;
}

/** Coalesce network chunks into browser frames without delaying or promoting the verified final answer. */
export function createStreamPreview(
  render: (text: string) => void,
  scheduler: PreviewScheduler = window,
): StreamPreview {
  let content = "";
  let frame: number | null = null;
  let closed = false;

  function cancel(): void {
    if (frame !== null) {
      scheduler.cancelAnimationFrame(frame);
      frame = null;
    }
  }

  return {
    append(text) {
      if (closed || text.length === 0) {
        return;
      }
      content += text;
      if (frame === null) {
        frame = scheduler.requestAnimationFrame(() => {
          frame = null;
          if (!closed) {
            render(content);
          }
        });
      }
    },
    reset() {
      cancel();
      content = "";
      if (!closed) {
        render(content);
      }
    },
    dispose() {
      closed = true;
      cancel();
      content = "";
    },
  };
}
