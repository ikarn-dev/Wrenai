import { useSyncExternalStore } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readPreference(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

// The server can't know the user's preference, so it renders the motion-free version.
function readPreferenceOnServer(): boolean {
  return true;
}

/** True when the user asked for reduced motion. Updates live if the setting changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readPreference, readPreferenceOnServer);
}
