import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { type DocEntry, groupOf, neighbors } from "@/docs/navigation";
import { PAGE_LOADERS } from "@/docs/pages";
import { pageHeadings } from "@/docs/source";
import { TableOfContents } from "./table-of-contents";

const ARROW = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

function PagerLink({
  entry,
  direction,
}: {
  readonly entry: DocEntry;
  readonly direction: "previous" | "next";
}): ReactElement {
  const next = direction === "next";
  return (
    <Link
      href={entry.href}
      className={`doc-card group flex flex-col gap-1 px-4 py-3.5 ${next ? "items-end text-right sm:col-start-2" : ""}`}
    >
      <span className="font-mono text-eyebrow text-fg-subtle uppercase">{next ? "Next" : "Previous"}</span>
      <span className="inline-flex items-center gap-1.5 text-body font-medium text-fg-strong">
        {next ? null : (
          <ArrowLeft
            {...ARROW}
            className="text-fg-subtle transition-transform duration-300 ease-ios group-hover:-translate-x-0.5"
          />
        )}
        {entry.title}
        {next ? (
          <ArrowRight
            {...ARROW}
            className="text-fg-subtle transition-transform duration-300 ease-ios group-hover:translate-x-0.5"
          />
        ) : null}
      </span>
    </Link>
  );
}

/**
 * One documentation page: the group as an eyebrow, the title and its one-line description, the MDX body, then the
 * previous and next pages. "On this page" sits beside it from xl.
 */
export async function DocPage({ entry }: { readonly entry: DocEntry }): Promise<ReactElement> {
  const load = PAGE_LOADERS[entry.file];
  if (!load) {
    throw new Error(`No loader for content/${entry.file}.mdx; add it to src/docs/pages.ts.`);
  }
  const { default: Content } = await load();
  const headings = pageHeadings(entry);
  const { previous, next } = neighbors(entry);
  return (
    <div className="flex min-w-0 flex-1 gap-12">
      <article className="min-w-0 max-w-reading flex-1 py-10 sm:py-12">
        <header className="flex flex-col gap-2 border-b border-line-subtle pb-8">
          <p className="font-mono text-eyebrow text-accent-text uppercase">{groupOf(entry)}</p>
          <h1 className="text-page-title">{entry.title}</h1>
          <p className="text-lead text-fg-muted">{entry.description}</p>
        </header>
        <div className="doc-prose pt-8">
          <Content />
        </div>
        <nav aria-label="Pages" className="mt-14 grid gap-stack sm:grid-cols-2">
          {previous ? <PagerLink entry={previous} direction="previous" /> : null}
          {next ? <PagerLink entry={next} direction="next" /> : null}
        </nav>
        <footer className="mt-10 border-t border-line-subtle pt-6 text-caption text-fg-subtle">
          Wrenai runs on NEAR mainnet. These pages describe the app as built; they are not financial advice.
        </footer>
      </article>
      <aside className="sticky top-header hidden h-[calc(100dvh-var(--spacing-header))] w-56 shrink-0 overflow-y-auto py-12 xl:block">
        <TableOfContents headings={headings} />
      </aside>
    </div>
  );
}
