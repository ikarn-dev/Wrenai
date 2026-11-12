"use client";

import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { AnimatePresence, domMax, LazyMotion, MotionConfig, m, type Transition } from "motion/react";
import Link from "next/link";
import { Tooltip } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { testnetApi } from "@/components/testnet/api";
import { AccountLabel } from "@/components/ui/account-label";
import { Badge, type BadgeTone, badgeClasses } from "@/components/ui/badge";
import { signOut } from "@/server/auth/actions";
import type { AppNetwork } from "@/shared/network";

export type AgentKeyStatus = "none" | "pending" | "active";

interface AccountMenuProps {
  /** The NEAR account ID, which is also the wallet's address. */
  readonly accountId: string;
  readonly network?: AppNetwork;
  readonly guest?: boolean;
  /** The agent key as last recorded; pages that show it in detail check it against NEAR. */
  readonly agentKey: AgentKeyStatus;
}

type CopyState = "idle" | "copied" | "failed";

// ease-ios (globals.css): fast start, long soft settle.
const EASE_IOS: [number, number, number, number] = [0.32, 0.72, 0, 1];
const MORPH: Transition = { duration: 0.42, ease: EASE_IOS };
// Animated through Motion, so the corners stay true while the surface is scaled mid-morph. Closed: a full pill
// (half the 36 px height). Open: 16 px, so the 6 px inset blocks inside use radius-sm (concentric corners).
const RADIUS_CLOSED = 16;
const RADIUS_OPEN = 16;

const KEY_STATUS: Readonly<Record<AgentKeyStatus, { readonly label: string; readonly tone: BadgeTone }>> = {
  active: { label: "Active", tone: "accent" },
  pending: { label: "Pending", tone: "warn" },
  none: { label: "Not authorized", tone: "neutral" },
};

const COPY_LABEL: Readonly<Record<CopyState, string>> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Couldn't copy",
};

interface CopyButtonProps {
  readonly state: CopyState;
  readonly onCopy: () => void;
}

// Icon only, so it carries an aria-label and a tooltip (Docs/DESIGN.md → Icons). The result is also announced.
function CopyButton({ state, onCopy }: CopyButtonProps) {
  const Icon = state === "copied" ? Check : Copy;
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy address"
            className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-xs transition-colors duration-300 ease-ios hover:bg-surface-2 hover:text-fg-strong pointer-coarse:size-11 ${state === "copied" ? "text-accent-text" : "text-fg-muted"}`}
          >
            <Icon aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-40 rounded-xs bg-surface-3 px-2 py-1 text-small text-fg-strong shadow-float"
          >
            {state === "idle" ? "Copy address" : COPY_LABEL[state]}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <span aria-live="polite" className="sr-only">
        {state === "idle" ? "" : COPY_LABEL[state]}
      </span>
    </Tooltip.Provider>
  );
}

interface PanelProps extends AccountMenuProps {
  readonly id: string;
  readonly copy: CopyState;
  readonly onCopy: () => void;
  readonly onNavigate: () => void;
}

function AccountPanel({
  id,
  accountId,
  agentKey,
  copy,
  onCopy,
  onNavigate,
  network = "mainnet",
  guest = false,
}: PanelProps) {
  const key = KEY_STATUS[agentKey];
  return (
    <div id={id} className="flex flex-col gap-3 p-1.5 pt-0">
      {/* The trigger sits over the right of this row, so the open panel's header is the pill itself. */}
      <div className="flex h-8 items-center px-1.5">
        <Badge tone="light" dot>
          {network === "testnet" ? "Testnet" : "Mainnet"}
        </Badge>
      </div>
      {/* Concentric with the panel: its 16 px corners minus the 6 px inset give radius-sm.
          On NEAR a named account is the address: funds and tokens are sent to it. */}
      <div className="flex items-center justify-between gap-2 rounded-sm bg-sunken py-1.5 pr-1.5 pl-3">
        <p className="min-w-0 font-mono text-small break-all text-fg-strong">{accountId}</p>
        {guest ? null : <CopyButton state={copy} onCopy={onCopy} />}
      </div>
      <div className="flex items-center justify-between gap-3 px-2.5">
        <span className="text-small whitespace-nowrap text-fg-subtle">
          {network === "testnet" ? "Access" : "Agent key"}
        </span>
        {network === "testnet" ? (
          <Badge tone="neutral">{guest ? "Test funds" : "Wallet approval"}</Badge>
        ) : (
          <Link
            href="/settings/trading-access"
            onClick={onNavigate}
            aria-label={`Agent key ${key.label}. Manage in Settings`}
            className="inline-flex min-h-8 items-center rounded-full pointer-coarse:min-h-11"
          >
            <Badge tone={key.tone} dot>
              {key.label}
              <ChevronRight aria-hidden="true" size={12} strokeWidth={1.75} absoluteStrokeWidth />
            </Badge>
          </Link>
        )}
      </div>
      {/* A document navigation, not a client route: each network keeps its own wallet and query state. */}
      <a
        href={network === "mainnet" ? "/testnet" : "/"}
        className={`${badgeClasses("neutral")} w-full justify-center transition-colors duration-300 ease-ios hover:text-fg-strong`}
      >
        <ArrowLeftRight aria-hidden="true" size={14} strokeWidth={1.75} absoluteStrokeWidth />
        Switch to {network === "mainnet" ? "Testnet" : "Mainnet"}
      </a>
      <form
        action={
          network === "testnet"
            ? async () => {
                await testnetApi({ command: "logout" });
                window.location.replace("/?network=testnet");
              }
            : signOut
        }
      >
        <button
          type="submit"
          className={`${badgeClasses("loss")} badge-button-glow w-full cursor-pointer justify-center`}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

/**
 * The account pill in the top bar. On click it morphs into a panel with the wallet details and sign-out: one
 * surface grows from the pill (Motion layout animation, transform only) while its row stays on top as the
 * panel's header. A disclosure, not a Radix menu: Radix positions its content in a portal after the first paint,
 * which gives the morph a wrong starting box.
 */
export function AccountMenu(props: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // A click or focus outside (tabbing past the last item) closes it; Escape closes it and returns focus to the pill.
  useEffect(() => {
    if (!open) {
      return;
    }
    function closeIfOutside(event: Event): void {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("focusin", closeIfOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("focusin", closeIfOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle(): void {
    setOpen((current) => !current);
    setCopy("idle");
  }

  async function copyAccountId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.accountId);
      setCopy("copied");
    } catch {
      // The browser refused clipboard access (permission or insecure context); the label says so.
      setCopy("failed");
    }
  }

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <div ref={rootRef} className="relative z-30 inline-flex min-w-0">
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={toggle}
            className="relative z-10 inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-full pr-2.5 pl-3"
          >
            <AccountLabel accountId={props.accountId} />
            <ChevronDown
              aria-hidden="true"
              size={14}
              strokeWidth={1.75}
              absoluteStrokeWidth
              className={`shrink-0 text-fg-muted transition-transform duration-300 ease-ios ${open ? "rotate-180" : ""}`}
            />
          </button>
          <m.div
            layout
            initial={false}
            animate={{ borderRadius: open ? RADIUS_OPEN : RADIUS_CLOSED }}
            transition={MORPH}
            // The card style (fill, lit edge, elevation) on the pill and the panel alike, so the morph is one card.
            className={`absolute top-0 right-0 overflow-hidden card-shine ${open ? "w-64" : "h-full w-full"}`}
          >
            {/* popLayout takes the closing panel out of flow at once, so the surface shrinks while it fades. */}
            <AnimatePresence mode="popLayout" initial={false}>
              {open ? (
                <m.div
                  key="panel"
                  layout="position"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.24, delay: 0.08 } }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                >
                  <AccountPanel
                    {...props}
                    id={panelId}
                    copy={copy}
                    onCopy={() => {
                      void copyAccountId();
                    }}
                    onNavigate={() => setOpen(false)}
                  />
                </m.div>
              ) : null}
            </AnimatePresence>
          </m.div>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
