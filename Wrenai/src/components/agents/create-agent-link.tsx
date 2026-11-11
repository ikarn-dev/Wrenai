"use client";

import type { MouseEvent, ReactElement, ReactNode } from "react";

interface CreateAgentLinkProps {
  readonly href: string;
  readonly className: string;
  readonly children: ReactNode;
}

/**
 * Opens the create dialog by updating the URL in the browser. Next syncs `history.pushState` with
 * `useSearchParams` without a server request, so the page doesn't re-run its reads and the dialog opens at once.
 * Modified clicks keep normal link behavior (new tab, copy link).
 */
export function CreateAgentLink({ href, className, children }: CreateAgentLinkProps): ReactElement {
  function open(event: MouseEvent<HTMLAnchorElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    window.history.pushState(null, "", href);
  }
  return (
    <a href={href} onClick={open} className={className}>
      {children}
    </a>
  );
}
