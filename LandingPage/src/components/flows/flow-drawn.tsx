"use client";

import { useNodesInitialized } from "@xyflow/react";
import { useEffect } from "react";

/**
 * Reports once React Flow has measured its nodes and drawn the lines a frame later, so a timeline can find the
 * lines' beams. Render it inside `<ReactFlow>`; `id` names the drawing and is passed back.
 */
export function FlowDrawn({
  id,
  onDrawn,
}: {
  readonly id: string;
  readonly onDrawn: (id: string) => void;
}): null {
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized) {
      return;
    }
    const frame = requestAnimationFrame(() => onDrawn(id));
    return () => cancelAnimationFrame(frame);
  }, [initialized, id, onDrawn]);
  return null;
}
