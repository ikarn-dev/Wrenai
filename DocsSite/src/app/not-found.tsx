import Link from "next/link";

export default function NotFound() {
  return (
    <div className="relative flex min-h-[60dvh] flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 dot-grid" />
      <p className="relative font-mono text-eyebrow text-fg-subtle uppercase">404</p>
      <h1 className="relative text-h2">This page isn't in the docs</h1>
      <p className="relative max-w-xs text-small text-fg-muted">
        It may have moved. Search with ⌘K or start over.
      </p>
      <Link href="/" className="relative mt-2 text-small text-accent-text hover:underline">
        Back to the introduction
      </Link>
    </div>
  );
}
