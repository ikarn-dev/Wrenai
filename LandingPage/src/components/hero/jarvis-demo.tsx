"use client";

import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { EXAMPLES, TOOLS } from "./jarvis-examples";
import { JarvisTyping } from "./jarvis-typing";

/**
 * Places the selection clip over the selected chip. Measured from the base row (the highlight copy lies exactly
 * over it), as inset distances from each edge of the row.
 */
function placeHighlight(row: HTMLElement, layer: HTMLElement, index: number): void {
  const chip = row.children.item(index);
  if (!(chip instanceof HTMLElement)) {
    return;
  }
  const top = chip.offsetTop;
  const left = chip.offsetLeft;
  layer.style.setProperty("--on-top", `${top}px`);
  layer.style.setProperty("--on-left", `${left}px`);
  layer.style.setProperty("--on-right", `${row.clientWidth - left - chip.offsetWidth}px`);
  layer.style.setProperty("--on-bottom", `${row.clientHeight - top - chip.offsetHeight}px`);
}

interface JarvisDemoProps {
  /** The submit button, rendered at the end of the tool row. */
  readonly children: ReactNode;
}

/**
 * The live part of the Jarvis card: the typed example and the tool chips, which select themselves to match it.
 * Neither takes input; Ask submits the selected tool through a hidden field.
 */
export function JarvisDemo({ children }: JarvisDemoProps): ReactElement {
  const [example, setExample] = useState(0);
  const tool = EXAMPLES[example]?.tool ?? TOOLS[0].id;
  const selected = TOOLS.findIndex((item) => item.id === tool);
  const rowRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Before paint, so the clip never shows at the old spot for a frame. Re-measured on resize and font swap,
  // which change chip widths; the first placement turns the transition on only after it has landed.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const layer = layerRef.current;
    if (row === null || layer === null) {
      return;
    }
    placeHighlight(row, layer, selected);
    const frame = requestAnimationFrame(() => layer.setAttribute("data-ready", ""));
    const observer = new ResizeObserver(() => placeHighlight(row, layer, selected));
    observer.observe(row);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [selected]);

  return (
    <>
      <JarvisTyping onExampleChange={setExample} />
      <div className="jarvis-row">
        <input type="hidden" name="tool" value={tool} />
        {/* The highlight layer comes last, so it paints over the (positioned) base chips. */}
        <div ref={rowRef} aria-hidden="true" className="jarvis-tools min-w-0 flex-1">
          {TOOLS.map((item) => (
            <span
              key={item.id}
              className="chip-shine jarvis-chip inline-flex items-center rounded-full text-ink-muted"
            >
              {item.label}
            </span>
          ))}
          <div ref={layerRef} className="jarvis-tools-on">
            {TOOLS.map((item) => (
              <span
                key={item.id}
                className="chip-shine chip-on jarvis-chip inline-flex items-center rounded-full"
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>
        {children}
      </div>
    </>
  );
}
