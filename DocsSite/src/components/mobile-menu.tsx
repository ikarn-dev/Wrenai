"use client";

import { Menu, X } from "lucide-react";
import { type ReactElement, useRef } from "react";
import { SidebarNav } from "./sidebar-nav";

const ICON = { "aria-hidden": true, size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/**
 * Below lg the sidebar opens as a sheet from the left: a native modal dialog, so focus, Escape and the backdrop come
 * from the browser. Choosing a page closes it.
 */
export function MobileMenu(): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = (): void => dialog.current?.close();
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label="Open navigation"
        className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong lg:hidden pointer-coarse:size-11"
      >
        <Menu {...ICON} />
      </button>
      <dialog
        ref={dialog}
        aria-label="Navigation"
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
        className="m-0 h-dvh max-h-none w-full max-w-xs bg-surface-1 p-0 text-fg shadow-float"
      >
        <div className="flex h-full flex-col">
          <div className="flex h-header shrink-0 items-center justify-between border-b border-line-subtle px-4">
            <span className="text-body font-medium text-fg-strong">Documentation</span>
            <button
              type="button"
              onClick={close}
              aria-label="Close navigation"
              className="inline-flex size-10 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong pointer-coarse:size-11"
            >
              <X {...ICON} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-6">
            <SidebarNav onNavigate={close} />
          </div>
        </div>
      </dialog>
    </>
  );
}
