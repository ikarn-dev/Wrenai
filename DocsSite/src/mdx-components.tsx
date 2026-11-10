import type { MDXComponents } from "mdx/types";
import { CodeBlock, DocLink, Heading, Table } from "@/components/mdx/blocks";
import { Callout } from "@/components/mdx/callout";
import { Card, Cards } from "@/components/mdx/cards";
import { Step, Steps } from "@/components/mdx/steps";

// Next's MDX convention: every page in content/ renders with these. Headings get anchors, links route in place,
// code gets a copy button, and the docs components are available without imports.
const COMPONENTS: MDXComponents = {
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  a: DocLink,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: Table,
  Callout,
  Card,
  Cards,
  Step,
  Steps,
};

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...COMPONENTS, ...components };
}
