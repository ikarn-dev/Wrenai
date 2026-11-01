"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { type ReactElement, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { type Notice, NoticeBox } from "@/components/ui/status-line";
import {
  checkTelegramLink,
  discardTelegramLink,
  disconnectTelegram,
  finishTelegramLink,
  startTelegramLink,
} from "@/server/telegram/actions";
import type { AgentResult } from "@/shared/agents";
import type { TelegramAccount, TelegramLinkState } from "@/shared/telegram";

function Account({ account }: { readonly account: TelegramAccount }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-sm bg-surface-1 p-4">
      <p className="break-words text-body font-medium text-fg-strong">
        {account.firstName}
        {account.username === null ? "" : ` · @${account.username}`}
      </p>
      <p className="text-small text-fg-subtle">
        Telegram ID <span className="font-mono tabular-nums">{account.telegramUserId}</span>
      </p>
    </div>
  );
}

export function TelegramConnection({ initial }: { readonly initial: TelegramLinkState }): ReactElement {
  const [state, setState] = useState(initial);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const requestId = useRef<string | null>(null);
  const [busy, startTransition] = useTransition();

  function run(action: () => Promise<AgentResult<TelegramLinkState>>): void {
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setNotice({ tone: "error", text: result.message });
          return;
        }
        setState(result.value);
        setConfirmUnlink(false);
        requestId.current = null;
      } catch {
        setNotice({
          tone: "error",
          text: "Telegram could not be updated. Check the connection status before trying again.",
        });
      }
    });
  }
  function begin(): void {
    requestId.current ??= crypto.randomUUID();
    const id = requestId.current;
    run(() => startTelegramLink({ requestId: id, expectedChallengeId: null }));
  }

  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      {state.kind === "unavailable" ? (
        <>
          <NoticeBox notice={{ tone: "info", text: "Telegram linking is not configured yet." }} />
          <div>
            <Button onClick={() => run(() => checkTelegramLink({}))} disabled={busy}>
              Check availability
            </Button>
          </div>
        </>
      ) : null}
      {state.kind === "unlinked" ? (
        <>
          <p className="text-body text-fg">No Telegram account linked.</p>
          <div>
            <Button variant="primary" onClick={begin} disabled={busy}>
              {busy ? "Connecting…" : "Link Telegram"}
            </Button>
          </div>
        </>
      ) : null}
      {state.kind === "waiting" ? (
        <>
          <p className="text-body text-fg">
            Open the bot and tap Start. Then return here to check and confirm your account.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={state.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-sm border border-line bg-surface-2 px-4 text-body font-medium text-fg-strong transition-colors duration-300 ease-ios hover:border-line-strong pointer-coarse:h-11"
            >
              Open Telegram
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            <Button onClick={() => run(() => checkTelegramLink({}))} disabled={busy}>
              Check connection
            </Button>
            <Button
              variant="ghost"
              onClick={() => run(() => discardTelegramLink({ challengeId: state.challengeId }))}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
          <p className="text-small text-fg-subtle">One-use link · Valid for five minutes after creation</p>
        </>
      ) : null}
      {state.kind === "confirm" ? (
        <>
          <p className="text-body text-fg">Confirm that this is your Telegram account.</p>
          <Account account={state.account} />
          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              onClick={() =>
                run(() =>
                  finishTelegramLink({
                    challengeId: state.challengeId,
                    telegramUserId: state.account.telegramUserId,
                  }),
                )
              }
              disabled={busy}
            >
              <Check size={16} aria-hidden="true" />
              Confirm account
            </Button>
            <Button
              onClick={() => run(() => discardTelegramLink({ challengeId: state.challengeId }))}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : null}
      {state.kind === "linked" ? (
        <>
          <p className="inline-flex items-center gap-2 text-small font-medium text-accent-text">
            <Check size={16} aria-hidden="true" />
            Telegram linked
          </p>
          <Account account={state.account} />
          {confirmUnlink ? (
            <div className="flex flex-col gap-3">
              <p className="text-body text-fg">
                Disconnect this Telegram account? You can link it again later.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => setConfirmUnlink(false)} disabled={busy}>
                  Keep linked
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => run(() => disconnectTelegram({ linkId: state.linkId }))}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button onClick={() => setConfirmUnlink(true)} disabled={busy}>
                Disconnect
              </Button>
            </div>
          )}
        </>
      ) : null}
      <div aria-live="polite">
        {notice === null ? null : <NoticeBox notice={notice} />}
        {busy ? <p className="text-small text-fg-subtle">Updating Telegram connection…</p> : null}
      </div>
      {notice === null ? null : (
        <div>
          <Button onClick={() => run(() => checkTelegramLink({}))} disabled={busy}>
            Check status
          </Button>
        </div>
      )}
      <p className="text-small text-fg-subtle">
        Account linking only. Alerts and agent commands are not available yet. Telegram can see messages sent
        to the bot.
      </p>
    </div>
  );
}
