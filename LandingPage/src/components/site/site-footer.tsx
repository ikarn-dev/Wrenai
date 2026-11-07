import type { ReactElement, ReactNode } from "react";
import { appHref } from "@/app-url";
import { Brand } from "./brand";
import { FooterPatches } from "./footer-patches";

// The page's close, drawn with the frame's own geometry: its rails run on through the footer, plain hairlines
// split it into cells and rows, with no fills, so the footer reads as the last part of the frame. Behind it: the green light and flat patches on a faint grid. Only
// real places and contacts: this page's sections, the team's email and X account.
const SECTIONS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agents", label: "Agents" },
  { href: "#privacy", label: "Privacy" },
  { href: "#faq", label: "FAQ" },
] as const;

const CONTACT = [
  { href: "mailto:mail.wrenai@gmail.com", label: "mail.wrenai@gmail.com", external: false },
  { href: "https://x.com/usewrenai", label: "X", external: true },
] as const;

// Links in fg (void-200, 13.92:1 on void-950) and headings in fg-muted, a step clearer than before.
const LINK = "rounded-sm text-hero-lead text-fg transition-colors duration-300 ease-ios hover:text-fg-strong";
// The frame's column: rails inside the gutter from sm, on the screen edges on phones (section-frame.tsx).
const COLUMN = "mx-auto w-full max-w-landing border-x border-line-card";

/** One footer row: the frame's full-width line above it, then its cells in the railed column. */
function Row({
  children,
  rule = true,
}: {
  readonly children: ReactNode;
  readonly rule?: boolean;
}): ReactElement {
  return (
    <div className="relative sm:px-gutter">
      {rule ? <div aria-hidden="true" className="frame-rule absolute inset-x-0 top-0" /> : null}
      <div className={COLUMN}>{children}</div>
    </div>
  );
}

/** A titled list of links in one cell. */
function LinkCell({
  id,
  title,
  className,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly className: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <nav aria-labelledby={id} className={`flex flex-col gap-4 p-frame ${className}`}>
      <p id={id} className="text-body font-medium text-fg-muted">
        {title}
      </p>
      <ul className="flex flex-col gap-3">{children}</ul>
    </nav>
  );
}

export function SiteFooter(): ReactElement {
  return (
    <footer className="footer-frame relative">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="footer-glow absolute inset-0" />
        <FooterPatches />
      </div>
      {/* The frame's closing line sits right above, so the first row draws none of its own. Phones: the brand
          cell, Links and Contact side by side, then the Launch app cell. From lg, four equal cells of three
          columns: brand, Links, Contact and Launch app, so Links and Contact are the same width. */}
      <Row rule={false}>
        <div className="grid grid-cols-2 lg:min-h-64 lg:grid-cols-12">
          <div className="col-span-2 flex flex-col items-start gap-3 p-frame lg:col-span-3">
            <a href="/" aria-label="Wrenai home" className="rounded-sm">
              <Brand size="lg" />
            </a>
            {/* The hero's headline as the footer's line, closing the page as it opened. */}
            <p className="text-hero-lead text-fg-muted">Private AI for your DeFi</p>
          </div>
          <LinkCell
            id="footer-links"
            title="Links"
            className="border-t border-line-card lg:col-span-3 lg:border-t-0 lg:border-l"
          >
            {SECTIONS.map((link) => (
              <li key={link.href}>
                <a href={link.href} className={LINK}>
                  {link.label}
                </a>
              </li>
            ))}
          </LinkCell>
          <LinkCell
            id="footer-contact"
            title="Contact"
            className="border-t border-l border-line-card lg:col-span-3 lg:border-t-0"
          >
            {CONTACT.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className={`${LINK} break-all`}
                  {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </LinkCell>
          {/* Launch app in its own plain cell. Phones: centered in its own row. From lg: at the top, on the logo's
              line (the 40 px button and the large brand row are about the same height, so their tops align). */}
          <div className="col-span-2 grid min-h-28 place-items-center border-t border-line-card lg:col-span-3 lg:items-start lg:border-t-0 lg:border-l lg:p-frame">
            <a
              href={appHref("/")}
              className="launch-shine inline-flex h-10 items-center rounded-full px-5 text-small font-medium text-fg-strong active:scale-97 motion-reduce:active:scale-100 pointer-coarse:h-11"
            >
              Launch app
            </a>
          </div>
        </div>
      </Row>
      <Row>
        {/* The name as the page's last mark; the brand link above already names it for screen readers. */}
        <div aria-hidden="true" className="footer-wordmark-box p-frame">
          <span className="footer-wordmark">
            Wren<span className="text-accent-text">ai</span>
          </span>
        </div>
      </Row>
    </footer>
  );
}
