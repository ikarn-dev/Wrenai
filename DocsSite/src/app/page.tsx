import type { Metadata } from "next";
import { DocPage } from "@/components/doc-page";
import { entryForHref } from "@/docs/navigation";

const entry = entryForHref("/");

export const metadata: Metadata = {
  title: { absolute: "Wrenai Docs" },
  description: entry?.description ?? "",
};

/** The introduction is the docs' home page. */
export default async function HomePage() {
  if (!entry) {
    throw new Error("The navigation needs an introduction page at /.");
  }
  return <DocPage entry={entry} />;
}
