"use client";

import { type ReactElement, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

// The same key public/theme.js reads before the first paint.
const STORAGE_KEY = "wrenai-theme";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** The theme lives on <html data-theme>, set before hydration by public/theme.js; this follows its changes. */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Remembers the choice when storage is available; when it isn't (some private modes) it lasts this visit. */
function remember(theme: Theme): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

function applyTheme(theme: Theme): void {
  remember(theme);
  const apply = (): void => {
    document.documentElement.setAttribute("data-theme", theme);
  };
  // One cross-fade of the whole page (theme.css → view transitions); browsers without it, and reduced motion, switch
  // at once.
  if ("startViewTransition" in document && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

/**
 * The nav's theme button. The icon's moon and sun states are drawn by CSS from <html data-theme>, so it is right on
 * the first paint, before React runs; React only supplies the label for the theme a press switches to.
 */
export function ThemeToggle(): ReactElement {
  // The server renders the dark default; a light visit corrects the label once, right after hydration.
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as const);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="theme-toggle"
    >
      <ThemeIcon />
    </button>
  );
}

// 18 px in a 24 unit box: 2.33 units draws the design's 1.75 px stroke (DESIGN.md → Icons, absoluteStrokeWidth).
const STROKE = 2.33;
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/**
 * A crescent that becomes a sun. The disc is masked by the "bite" circle (the crescent's outer edge), and the bite's
 * own stroke, clipped to the disc, draws the inner edge; sliding the bite away and shrinking the disc leaves the
 * sun's core, and eight rays grow in around it. IDs are fixed: there is one theme button on the page.
 */
function ThemeIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      className="theme-icon"
    >
      <defs>
        <mask id="theme-bite-mask" maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36">
          <rect x="-6" y="-6" width="36" height="36" fill="#fff" stroke="none" />
          <circle data-part="bite" cx="17.5" cy="6.5" r="6" fill="#000" stroke="none" />
        </mask>
        <clipPath id="theme-disc-clip">
          <circle data-part="disc" cx="12" cy="12" r="8.5" />
        </clipPath>
      </defs>
      <circle data-part="disc" cx="12" cy="12" r="8.5" mask="url(#theme-bite-mask)" />
      <g clipPath="url(#theme-disc-clip)">
        <circle data-part="bite" cx="17.5" cy="6.5" r="6" />
      </g>
      <g data-part="rays">
        {RAYS.map((angle) => (
          <line key={angle} x1="12" y1="2.25" x2="12" y2="3.75" transform={`rotate(${angle} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}
