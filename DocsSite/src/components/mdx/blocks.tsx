import { Hash } from "lucide-react";
import Link from "next/link";
import { type ComponentPropsWithoutRef, isValidElement, type ReactElement, type ReactNode } from "react";
import { slugify, textOf } from "@/docs/text";
import { CopyButton } from "./copy-button";

/** A section heading with its own anchor; a hash mark shows on hover, like Mintlify's. */
export function Heading({
  level,
  children,
}: {
  readonly level: 2 | 3;
  readonly children: ReactNode;
}): ReactElement {
  const id = slugify(textOf(children));
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag id={id} className="group relative">
      <a href={`#${id}`} className="doc-anchor">
        {children}
        <Hash
          aria-hidden="true"
          size={14}
          strokeWidth={1.75}
          absoluteStrokeWidth
          className="ml-2 inline align-baseline text-fg-subtle opacity-0 transition-opacity duration-200 ease-ios group-hover:opacity-100"
        />
      </a>
    </Tag>
  );
}

/** Internal links navigate in place; anything else opens in a new tab. */
export function DocLink({ href = "", children }: ComponentPropsWithoutRef<"a">): ReactElement {
  if (href.startsWith("/") || href.startsWith("#")) {
    return <Link href={href}>{children}</Link>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A fenced code block: its language as a mono tab, the code on the sunken well, and a copy button. */
export function CodeBlock({ children }: { readonly children?: ReactNode }): ReactElement {
  const code = isValidElement<{ readonly className?: string }>(children)
    ? children.props.className
    : undefined;
  const language = /language-(\w+)/.exec(code ?? "")?.[1] ?? "text";
  const text = textOf(children).replace(/\n$/, "");
  return (
    <div className="overflow-hidden rounded-md bg-sunken ring-1 ring-line-card ring-inset">
      <div className="flex h-9 items-center justify-between border-b border-line-card pr-1 pl-4">
        <span className="font-mono text-caption text-fg-subtle">{language}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto overscroll-x-contain px-4 py-3.5 font-mono text-small leading-relaxed text-fg-strong">
        {children}
      </pre>
    </div>
  );
}

/** A Markdown table inside its scroll well (prose.css → doc-table). */
export function Table(props: ComponentPropsWithoutRef<"table">): ReactElement {
  return (
    <div className="doc-table">
      <table {...props} />
    </div>
  );
}
