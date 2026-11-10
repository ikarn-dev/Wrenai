import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocPage } from "@/components/doc-page";
import { ALL_PAGES, entryForHref } from "@/docs/navigation";

interface PageProps {
  readonly params: Promise<{ readonly slug: readonly string[] }>;
}

// Every page is listed in the navigation and built ahead of time; any other path is a 404.
export const dynamicParams = false;

export function generateStaticParams(): { slug: string[] }[] {
  return ALL_PAGES.filter((entry) => entry.href !== "/").map((entry) => ({
    slug: entry.href.slice(1).split("/"),
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const entry = entryForHref(`/${(await params).slug.join("/")}`);
  return entry ? { title: entry.title, description: entry.description } : {};
}

export default async function DocsPage({ params }: PageProps) {
  const entry = entryForHref(`/${(await params).slug.join("/")}`);
  if (!entry) {
    notFound();
  }
  return <DocPage entry={entry} />;
}
