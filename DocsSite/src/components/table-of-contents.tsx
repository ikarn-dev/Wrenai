"use client";

import { type ReactElement, useEffect, useState } from "react";
import type { Heading } from "@/docs/source";

/**
 * "On this page", Mintlify style: the page's headings on a hairline rail, the section being read marked in mint. The
 * mark follows the heading nearest the top of the viewport, from an IntersectionObserver rather than scroll events.
 */
export function TableOfContents({
  headings,
}: {
  readonly headings: readonly Heading[];
}): ReactElement | null {
  const [current, setCurrent] = useState(headings[0]?.id ?? "");
  useEffect(() => {
    const elements = headings.flatMap((heading) => document.getElementById(heading.id) ?? []);
    if (elements.length === 0) {
      return;
    }
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(entry.target.id);
          } else {
            visible.delete(entry.target.id);
          }
        }
        // The first heading in the reading band wins; above every band, the last one scrolled past.
        const first = elements.find((element) => visible.has(element.id));
        const passed = elements.filter((element) => element.getBoundingClientRect().top < 120).at(-1);
        const next = first ?? passed;
        if (next) {
          setCurrent(next.id);
        }
      },
      { rootMargin: "-88px 0px -55% 0px" },
    );
    for (const element of elements) {
      observer.observe(element);
    }
    return () => observer.disconnect();
  }, [headings]);
  if (headings.length === 0) {
    return null;
  }
  return (
    <nav aria-label="On this page" className="flex flex-col gap-3">
      <p className="font-mono text-eyebrow text-fg-subtle uppercase">On this page</p>
      <ul className="flex flex-col border-l border-line-card">
        {headings.map((heading) => {
          const active = heading.id === current;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={active ? "location" : undefined}
                className={`-ml-px block border-l py-1 text-small transition-colors duration-200 ease-ios ${heading.level === 3 ? "pl-6" : "pl-3"} ${active ? "border-accent text-accent-text" : "border-transparent text-fg-subtle hover:text-fg-strong"}`}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
