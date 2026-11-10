"use client";

import { CornerDownLeft, FileText, Hash, Search as SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SearchRecord } from "@/docs/source";

const ICON = { "aria-hidden": true, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;
const MAX_RESULTS = 8;

interface Result {
  readonly record: SearchRecord;
  readonly snippet: string;
}

function isRecord(value: unknown): value is SearchRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const fields = Object.entries(value);
  const field = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  return (
    typeof field("href") === "string" &&
    typeof field("page") === "string" &&
    typeof field("group") === "string" &&
    typeof field("text") === "string" &&
    (field("section") === null || typeof field("section") === "string")
  );
}

/** The index the build wrote (app/search-index.json/route.ts), fetched once on first open. */
async function loadIndex(): Promise<readonly SearchRecord[]> {
  const response = await fetch("/search-index.json");
  const value: unknown = await response.json();
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Every word must appear; titles outrank sections, which outrank body text. */
function search(index: readonly SearchRecord[], query: string): readonly Result[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  return index
    .flatMap((record) => {
      const page = record.page.toLowerCase();
      const section = (record.section ?? "").toLowerCase();
      const text = record.text.toLowerCase();
      if (!words.every((word) => page.includes(word) || section.includes(word) || text.includes(word))) {
        return [];
      }
      const score = words.reduce(
        (total, word) => total + (page.includes(word) ? 4 : 0) + (section.includes(word) ? 2 : 0),
        record.section === null ? 1 : 0,
      );
      const at = Math.max(0, text.indexOf(words[0] ?? ""));
      const start = Math.max(0, at - 40);
      const snippet = `${start > 0 ? "…" : ""}${record.text.slice(start, start + 140).trim()}…`;
      return [{ record, snippet, score }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
}

/**
 * Search, Mintlify style: a wide field in the header that opens a dialog (⌘K or Ctrl+K, or "/"). It searches a
 * static index in the browser, so no search service sees what readers look for.
 */
export function Search(): ReactElement {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState<readonly SearchRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = index ? search(index, query) : [];

  function open(): void {
    setQuery("");
    setActive(0);
    dialog.current?.showModal();
    input.current?.focus();
    if (index === null) {
      loadIndex().then(setIndex, () => setFailed(true));
    }
  }

  function close(): void {
    dialog.current?.close();
  }

  function go(result: Result | undefined): void {
    if (result) {
      close();
      router.push(result.record.href);
    }
  }

  // The shortcuts are global, so they listen on the document once; the listener calls the latest open through a
  // ref. Typing "/" in a field still types a slash.
  const openLatest = useRef(open);
  useLayoutEffect(() => {
    openLatest.current = open;
  });
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        openLatest.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label="Search documentation"
        aria-keyshortcuts="Meta+K Control+K"
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full text-small text-fg-subtle transition-colors duration-200 ease-ios hover:text-fg-muted max-md:size-10 max-md:justify-center md:w-64 md:card-shine md:px-3.5 pointer-coarse:max-md:size-11"
      >
        <SearchIcon {...ICON} size={16} className="shrink-0" />
        <span className="hidden flex-1 text-left md:inline">Search docs…</span>
        <span aria-hidden="true" className="kbd hidden md:inline-flex">
          ⌘K
        </span>
      </button>
      <dialog
        ref={dialog}
        aria-label="Search documentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            close();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
          }
        }}
        className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl bg-surface-2 p-0 text-fg shadow-float"
      >
        <div className="flex items-center gap-3 border-b border-line-card px-4">
          <SearchIcon {...ICON} size={18} className="shrink-0 text-fg-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search the docs"
            aria-label="Search the docs"
            autoComplete="off"
            spellCheck={false}
            className="h-14 min-w-0 flex-1 bg-transparent text-body text-fg-strong outline-none placeholder:text-fg-subtle focus-visible:outline-none"
          />
          <span aria-hidden="true" className="kbd">
            Esc
          </span>
        </div>
        <p role="status" className="sr-only">
          {index && query.trim() ? `${results.length.toString()} results` : ""}
        </p>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain p-2">
          {failed ? (
            <p role="alert" className="px-3 py-8 text-center text-small text-warn">
              Search couldn't load. Refresh the page and try again.
            </p>
          ) : query.trim() === "" ? (
            <p className="px-3 py-8 text-center text-small text-fg-subtle">Type to search every page.</p>
          ) : index && results.length === 0 ? (
            <p role="status" className="px-3 py-8 text-center text-small text-fg-muted">
              No results for “{query.trim()}”
            </p>
          ) : (
            <ul aria-label="Results" className="flex flex-col gap-0.5">
              {results.map((result, position) => {
                const Icon = result.record.section ? Hash : FileText;
                const selected = position === active;
                return (
                  <li key={result.record.href}>
                    <a
                      href={result.record.href}
                      onClick={(event) => {
                        event.preventDefault();
                        go(result);
                      }}
                      onMouseMove={() => setActive(position)}
                      aria-current={selected ? "true" : undefined}
                      className={`flex items-start gap-3 rounded-md px-3 py-2.5 ${selected ? "bg-surface-3" : ""}`}
                    >
                      <Icon {...ICON} size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-small font-medium text-fg-strong">
                          {result.record.section ?? result.record.page}
                        </span>
                        <span className="truncate text-caption text-fg-subtle">
                          {result.record.section
                            ? `${result.record.group} · ${result.record.page}`
                            : result.record.group}
                        </span>
                        <span className="line-clamp-2 text-caption text-fg-muted">{result.snippet}</span>
                      </span>
                      {selected ? (
                        <CornerDownLeft {...ICON} size={14} className="mt-1 shrink-0 text-fg-subtle" />
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </dialog>
    </>
  );
}
