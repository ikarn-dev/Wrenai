import { isValidElement, type ReactNode } from "react";

/**
 * A heading's anchor: lower case, letters and digits joined by single hyphens. The MDX heading components and the
 * source scan (source.ts) both use it, so the contents list always points at real anchors.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

/** Inline Markdown to plain text: code ticks, emphasis and links reduced to their words. */
export function plainInline(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .trim();
}

/** The text inside rendered children, so a heading's anchor matches its words whatever inline markup it holds. */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
}
