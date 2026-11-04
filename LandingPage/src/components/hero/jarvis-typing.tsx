"use client";

import { type ReactElement, useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";
import { EXAMPLES } from "./jarvis-examples";

// Typing pace per character, slightly uneven like a person, a touch longer after a space or punctuation.
const CHAR_MIN_MS = 24;
const CHAR_MAX_MS = 52;
const PAUSE_MS = 70;
const HOLD_MS = 1800;
const ERASE_MS = 14;
// Long enough for the tool highlight to slide (520 ms) before the next question starts.
const GAP_MS = 560;

type Phase = "type" | "hold" | "erase" | "gap";

function exampleText(index: number): string {
  return EXAMPLES[index]?.text ?? "";
}

/** Cumulative reveal times (ms from the start of typing) for each character of a line. */
function typingSchedule(text: string): readonly number[] {
  const times: number[] = [];
  let at = 0;
  for (const char of text) {
    at += CHAR_MIN_MS + Math.random() * (CHAR_MAX_MS - CHAR_MIN_MS) + (/[\s,?.!]/.test(char) ? PAUSE_MS : 0);
    times.push(at);
  }
  return times;
}

function shuffle(values: number[]): number[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = values[i];
    const b = values[j];
    if (a !== undefined && b !== undefined) {
      values[i] = b;
      values[j] = a;
    }
  }
  return values;
}

/**
 * Every example once, the first first (it's already on screen), the rest shuffled so that the tool changes on
 * every line, including the wrap back to the first, and the highlight always has somewhere to slide.
 */
function playOrder(): readonly number[] {
  const toolOf = (index: number | undefined) => (index === undefined ? undefined : EXAMPLES[index]?.tool);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const order = [0, ...shuffle(EXAMPLES.map((_, index) => index).slice(1))];
    const changes = order.every((index, i) => toolOf(index) !== toolOf(order[(i + 1) % order.length]));
    if (changes) {
      return order;
    }
  }
  return EXAMPLES.map((_, index) => index);
}

interface JarvisTypingProps {
  /** Called with the next example's index as the box empties, before that line starts typing. */
  readonly onExampleChange: (index: number) => void;
}

/**
 * Example questions typed into Jarvis's box, character by character, then erased for the next one. Display only:
 * there is no input to type into. The server renders the first example whole, so the box is never empty and
 * works without JavaScript; under reduced motion it stays on that line.
 *
 * One requestAnimationFrame loop writes the visible text straight into a text node, so React never re-renders
 * while it types and each frame costs one string write. Characters land on frame boundaries from elapsed time,
 * so the pace stays even when frames drop. The loop stops while the box is off screen or the tab is hidden and
 * resumes where it left off.
 */
export function JarvisTyping({ onExampleChange }: JarvisTypingProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    const textNode = textRef.current;
    if (reducedMotion || box === null || textNode === null) {
      return;
    }
    const order = playOrder();
    let position = 0;
    let text = exampleText(0);
    let schedule = typingSchedule(text);
    let phase: Phase = "hold";
    let phaseStart = performance.now();
    let shown = text.length;
    let frame = 0;
    let pausedAt: number | null = null;
    let onScreen = false;
    const at = (offset: number): number => order[(position + offset) % order.length] ?? 0;

    const show = (count: number): void => {
      if (count !== shown) {
        shown = count;
        textNode.textContent = text.slice(0, count);
      }
    };
    const enter = (next: Phase, now: number): void => {
      phase = next;
      phaseStart = now;
      // The caret blinks only while the line rests; it stays solid while typing or erasing.
      box.toggleAttribute("data-idle", next === "hold" || next === "gap");
      if (next === "gap") {
        onExampleChange(at(1));
      }
    };
    const step = (now: number): void => {
      const elapsed = now - phaseStart;
      if (phase === "type") {
        let count = shown;
        while (count < schedule.length && (schedule[count] ?? Infinity) <= elapsed) {
          count += 1;
        }
        show(count);
        if (count >= text.length) {
          enter("hold", now);
        }
      } else if (phase === "hold") {
        if (elapsed >= HOLD_MS) {
          enter("erase", now);
        }
      } else if (phase === "erase") {
        show(Math.max(0, text.length - Math.floor(elapsed / ERASE_MS)));
        if (shown === 0) {
          enter("gap", now);
        }
      } else if (elapsed >= GAP_MS) {
        position += 1;
        text = exampleText(at(0));
        schedule = typingSchedule(text);
        enter("type", now);
      }
      frame = requestAnimationFrame(step);
    };
    const sync = (): void => {
      const run = onScreen && !document.hidden;
      if (run && frame === 0) {
        // Shift the current phase by the paused time, so nothing is skipped or replayed.
        if (pausedAt !== null) {
          phaseStart += performance.now() - pausedAt;
          pausedAt = null;
        }
        frame = requestAnimationFrame(step);
      } else if (!run && frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
        pausedAt = performance.now();
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? false;
      sync();
    });
    enter("hold", phaseStart);
    observer.observe(box);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [reducedMotion, onExampleChange]);

  return (
    <div ref={boxRef} aria-hidden="true" className="jarvis-input jarvis-typing w-full">
      <span ref={textRef}>{exampleText(0)}</span>
      <span className="jarvis-caret" />
    </div>
  );
}
