import { memo, type ReactElement } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy-button";

const components: Components = {
  a({ href, children }) {
    if (!href || !/^https?:\/\//i.test(href)) {
      return <span>{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-words text-accent-text underline decoration-accent-line underline-offset-4 hover:decoration-accent-text"
      >
        {children}
      </a>
    );
  },
  img({ alt }) {
    // Never fetch model-supplied image URLs: they could disclose the reader's address or encode account data.
    return alt ? <span className="text-fg-muted">[Image: {alt}]</span> : null;
  },
  pre({ node, children }) {
    const code =
      node?.children
        .flatMap((child) =>
          child.type === "element" && child.tagName === "code"
            ? child.children.flatMap((part) => (part.type === "text" ? [part.value] : []))
            : [],
        )
        .join("") ?? "";
    return (
      <div className="my-4 min-w-0 overflow-hidden rounded-sm bg-sunken">
        <div className="flex items-center justify-between border-b border-line-subtle px-4 text-caption text-fg-subtle">
          <span>Code</span>
          <CopyButton text={code} label="Copy code" />
        </div>
        <pre className="overflow-x-auto overscroll-x-contain p-4 font-mono text-small leading-relaxed">
          {children}
        </pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 min-w-0 overflow-x-auto overscroll-x-contain">
        <table className="w-full table-fixed border-collapse text-left text-small">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="wrap-anywhere border-b border-line px-3 py-3 align-top font-medium text-fg-strong">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="wrap-anywhere border-b border-line-subtle px-3 py-3 align-top">{children}</td>;
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
}: {
  readonly content: string;
}): ReactElement {
  return (
    <div className="min-w-0 break-words text-body leading-relaxed [&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-h2 [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-3 [&_h2]:text-h3 [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-body [&_h3]:font-semibold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted [&_code]:font-mono [&_code]:text-small [&_hr]:my-5 [&_hr]:border-line-subtle">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
});
