"use client";

import { Button } from "@/components/ui/button";

interface ErrorPageProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-reading flex-col justify-center gap-6 px-gutter">
      <h1 className="font-display text-h1">Something went wrong</h1>
      <p className="text-body text-fg">
        This page couldn't load. Try again; if it keeps happening, sign out and back in.
      </p>
      {error.digest !== undefined ? (
        <p className="font-mono text-small text-fg-subtle">Reference {error.digest}</p>
      ) : null}
      <div>
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
