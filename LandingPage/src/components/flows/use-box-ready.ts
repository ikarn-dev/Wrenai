"use client";

import { type RefObject, useEffect, useState } from "react";

/**
 * True once the box has a real width and height. React Flow measures its parent the moment it mounts and reports
 * error 004 if either side is 0, which happens when a diagram mounts before its box is laid out (a lazily loaded
 * chunk, styles still arriving). Rendering the canvas only after this is true means it always mounts into a sized
 * box; it stays true afterwards, and later resizes are handled by FlowFit.
 */
export function useBoxReady(box: RefObject<HTMLElement | null>): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || ready) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setReady(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, ready]);
  return ready;
}
