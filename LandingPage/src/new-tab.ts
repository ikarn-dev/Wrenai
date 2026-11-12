/**
 * Props for every link into the app or the docs: a new tab, so the landing page stays open behind it. A plain module,
 * so client components can use it without importing the build-time app URL.
 */
export const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;
