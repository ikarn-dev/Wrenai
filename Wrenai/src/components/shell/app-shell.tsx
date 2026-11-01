"use client";

import { LayoutGroup, LazyMotion, MotionConfig, m, type Transition } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { usePrefersReducedMotion } from "@/components/motion/use-prefers-reduced-motion";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";

// The card and page move together on ease-ios; no entrance animation on the initial render.
const SIDEBAR_TRANSITION: Transition = { duration: 0.42, ease: [0.32, 0.72, 0, 1] };
const INSTANT: Transition = { duration: 0 };

async function loadLayoutFeatures(): Promise<typeof import("motion/react")["domMax"]> {
  return (await import("../motion/layout-features")).layoutFeatures;
}

interface AppShellProps {
  readonly initiallyCollapsed: boolean;
  readonly header: ReactNode;
  readonly children: ReactNode;
}

/** Synchronizes the sidebar and page without scaling the page's text or moving the account menu. */
export function AppShell({ initiallyCollapsed, header, children }: AppShellProps): ReactElement {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <LazyMotion features={loadLayoutFeatures} strict>
      <MotionConfig reducedMotion="user" transition={reducedMotion ? INSTANT : SIDEBAR_TRANSITION}>
        <LayoutGroup>
          <div className="mx-auto flex min-h-dvh max-w-app">
            <Sidebar initiallyCollapsed={initiallyCollapsed} />
            <div className="flex min-w-0 flex-1 flex-col">
              {header}
              <m.div layout="position" initial={false} className="flex flex-1 flex-col">
                {children}
              </m.div>
            </div>
            <MobileNav />
          </div>
        </LayoutGroup>
      </MotionConfig>
    </LazyMotion>
  );
}
