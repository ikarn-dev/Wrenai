import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_PAGES, type DocEntry, groupOf } from "./navigation";
import { plainInline, slugify } from "./text";

// Build-time reads of the MDX sources (the site is a static export, so these run once while it builds): headings
// for each page's contents list, and plain text for the search index.

export interface Heading {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3;
}

export interface SearchRecord {
  readonly href: string;
  readonly page: string;
  readonly group: string;
  readonly section: string | null;
  readonly text: string;
}

function source(entry: DocEntry): string {
  return readFileSync(join(process.cwd(), "content", `${entry.file}.mdx`), "utf8");
}

/** Source lines outside fenced code blocks, where a "#" is code, not a heading. */
function proseLines(text: string): readonly string[] {
  let fenced = false;
  return text.split("\n").filter((line) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

function heading(line: string): Heading | null {
  const match = /^(##|###) (.+)$/.exec(line.trim());
  if (!match?.[2]) {
    return null;
  }
  const text = plainInline(match[2]);
  return { id: slugify(text), text, level: match[1] === "##" ? 2 : 3 };
}

/** The page's second- and third-level headings, in order. */
export function pageHeadings(entry: DocEntry): readonly Heading[] {
  return proseLines(source(entry)).flatMap((line) => heading(line) ?? []);
}

/** A source line as searchable words: components' title attributes kept, tags and Markdown marks dropped. */
function searchable(line: string): string {
  const titles = [...line.matchAll(/title="([^"]*)"/g)].map((match) => match[1] ?? "");
  const text = plainInline(line.replace(/<[^>]*>/g, " ").replace(/^[>\-*\d.|\s]+/, ""))
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ");
  return [...titles, text].join(" ").trim();
}

/** One record per page section, so a search result can open the exact heading it matched. */
export function searchRecords(): readonly SearchRecord[] {
  return ALL_PAGES.flatMap((entry) => {
    const records: SearchRecord[] = [];
    let section: Heading | null = null;
    let words: string[] = [];
    const flush = (): void => {
      const text = words.join(" ").trim();
      if (text || section) {
        records.push({
          href: section ? `${entry.href}#${section.id}` : entry.href,
          page: entry.title,
          group: groupOf(entry),
          section: section?.text ?? null,
          text: text.slice(0, 1200),
        });
      }
    };
    for (const line of proseLines(source(entry))) {
      const found = heading(line);
      if (found) {
        flush();
        section = found;
        words = [];
      } else if (line.trim() && !line.startsWith("import ")) {
        words.push(searchable(line));
      }
    }
    flush();
    return records;
  });
}
