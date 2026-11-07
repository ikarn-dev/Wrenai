"use client";

import { type FitViewOptions, useNodesInitialized, useReactFlow } from "@xyflow/react";
import { type RefObject, useEffect } from "react";

/**
 * Keeps a static diagram fitted to its box. React Flow's `fitView` runs once, at the size the box had then; a
 * rotated phone, a resized window or a box that settles after load would leave the diagram cropped or oversized.
 * Render it inside `<ReactFlow>` and pass the box and the same options as `fitViewOptions`.
 */
export function FlowFit({
  box,
  options,
}: {
  readonly box: RefObject<HTMLElement | null>;
  readonly options: FitViewOptions;
}): null {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    const element = box.current;
    if (!element || !initialized) {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      // One fit per frame, after layout settles; the promise only reports when the (instant) fit is done.
      frame = requestAnimationFrame(() => {
        void fitView(options);
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [box, initialized, fitView, options]);
  return null;
}
