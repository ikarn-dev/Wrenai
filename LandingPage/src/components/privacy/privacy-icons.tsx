import type { ReactElement, ReactNode } from "react";

// Line icons for the privacy flow, drawn on a 24 px grid like the agent icons: 1.75 px round strokes, a single
// filled point at most.
export type PrivacyGlyph = "chat" | "strategy" | "account" | "private" | "public";

const GLYPHS: Readonly<Record<PrivacyGlyph, ReactNode>> = {
  // What you ask Jarvis.
  chat: (
    <>
      <path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z" />
      <path d="M8.5 10.5h7" />
    </>
  ),
  // A strategy: a page of rules.
  strategy: (
    <>
      <path d="M6.5 3.5h8l3 3v14h-11z" />
      <path d="M9.5 7.5h2" />
      <path d="M9.5 11h5" />
      <path d="M9.5 14.5h5" />
    </>
  ),
  // Account context: the wallet balance Jarvis may read.
  account: (
    <>
      <rect x="3.5" y="6.5" width="17" height="12" rx="2.5" />
      <path d="M3.5 10h17" />
      <circle cx="16.5" cy="14.25" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Hidden from the public chain.
  private: (
    <>
      <rect x="5.5" y="10.5" width="13" height="10" rx="2.5" />
      <path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3" />
      <circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Visible on a public chain or venue.
  public: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
};

/** A privacy-flow icon in the text color. Decorative: the diagram is described for screen readers separately. */
export function PrivacyIcon({
  glyph,
  size = 18,
}: {
  readonly glyph: PrivacyGlyph;
  readonly size?: number;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[glyph]}
    </svg>
  );
}
