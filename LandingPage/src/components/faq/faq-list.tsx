"use client";

import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";

export interface Faq {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

// The site's iOS curve (globals.css → --ease-ios): a fast start and a long soft settle. Opening takes a little
// longer than closing, as iOS sheets do.
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const OPEN_MS = 520;
const CLOSE_MS = 380;
const REDUCED = "(prefers-reduced-motion: reduce)";
const running = new WeakMap<HTMLElement, Animation>();

/**
 * Opens or closes one item by animating its panel's height from wherever it is now, so a second click mid-way
 * reverses smoothly. The element's own `open` state is the only state: no React state, so nothing re-renders.
 * Closing keeps the item open until the motion ends (`data-closing` turns the chevron back at once).
 */
function toggle(details: HTMLDetailsElement, panel: HTMLElement): void {
  // A closed item's content isn't laid out, so it starts from 0; otherwise from the current (possibly mid-motion)
  // height, read before the running motion is cancelled.
  const from = details.open ? panel.getBoundingClientRect().height : 0;
  running.get(panel)?.cancel();
  const closing = details.open && !details.hasAttribute("data-closing");
  if (closing) {
    details.setAttribute("data-closing", "");
    const motion = panel.animate([{ height: `${from}px` }, { height: "0px" }], {
      duration: CLOSE_MS,
      easing: EASE,
      fill: "forwards",
    });
    running.set(panel, motion);
    motion.onfinish = () => {
      details.open = false;
      details.removeAttribute("data-closing");
      motion.cancel();
      running.delete(panel);
    };
    return;
  }
  details.removeAttribute("data-closing");
  details.open = true;
  const to = panel.scrollHeight;
  const motion = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: OPEN_MS,
    easing: EASE,
  });
  running.set(panel, motion);
  motion.onfinish = () => running.delete(panel);
}

/** A summary was pressed: animate its item instead of the browser's instant toggle. */
function onListClick(event: MouseEvent): void {
  // Reduced motion keeps the browser's own instant toggle.
  if (!(event.target instanceof Element) || window.matchMedia(REDUCED).matches) {
    return;
  }
  const details = event.target.closest("summary")?.parentElement;
  const panel = details?.querySelector(".faq-panel");
  if (!(details instanceof HTMLDetailsElement) || !(panel instanceof HTMLElement)) {
    return;
  }
  event.preventDefault();
  toggle(details, panel);
}

/**
 * The questions as native disclosure items. One delegated native listener animates whichever summary was pressed
 * (click, Enter or Space all fire `click` on a summary); it's attached once, so nothing re-renders.
 */
export function FaqList({ items }: { readonly items: readonly Faq[] }): ReactElement {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = list.current;
    if (!element) {
      return;
    }
    element.addEventListener("click", onListClick);
    return () => element.removeEventListener("click", onListClick);
  }, []);

  return (
    <div ref={list} className="faq-list">
      {items.map((item) => (
        <details key={item.id} className="faq-item">
          <summary className="faq-question">
            <span>{item.question}</span>
            <ChevronDown
              size={18}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
              className="faq-chevron"
            />
          </summary>
          <div className="faq-panel">
            <p className="faq-answer">{item.answer}</p>
          </div>
        </details>
      ))}
    </div>
  );
}
