"use client";
import { base64urlnopad } from "@scure/base";
import { type FormEvent, type ReactElement, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { notify, useToastState } from "@/components/ui/toast";
import { walletForAccount } from "@/components/wallet/near-connector";
import { attempt, walletNotice } from "@/components/wallet/notices";
import {
  confirmRecoveryBackup,
  exportRecoveryBackup,
  requestRecoveryBackup,
} from "@/server/trading-accounts/actions";
import { recoveryFileHash, sealRecoveryFile } from "@/shared/recovery-file";
import type { TradingAccountSummary } from "@/shared/trading-recovery";

function downloadBackup(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "wrenai-encrypted-recovery.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TradingRecovery({
  accountId,
  agents,
  initial,
}: {
  readonly accountId: string;
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly initial: TradingAccountSummary | null;
}): ReactElement {
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useToastState("warn");
  const [confirmed, setConfirmed] = useState(initial?.backupConfirmed ?? false);
  const [confirmation, setConfirmation] = useState<{
    readonly accountId: string;
    readonly token: string;
    readonly fileHash: string;
    readonly file: string;
  } | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    if (password.length < 12 || password !== data.get("repeatPassword")) {
      setError("Use at least 12 characters and enter the same password twice.");
      return;
    }
    const agentId = String(data.get("agentId") ?? "");
    startTransition(async () => {
      setError(null);
      setMessage("Preparing ownership check…");
      try {
        const challenge = await requestRecoveryBackup({ agentId });
        if (!challenge.ok) {
          setError(challenge.message);
          return;
        }
        const wallet = await walletForAccount(accountId, "authorize", () =>
          setMessage("Choose your wallet…"),
        );
        if (!wallet.ok) {
          setError(wallet.notice.text);
          return;
        }
        setMessage("Confirm recovery export in your wallet…");
        const signed = await attempt(
          () =>
            wallet.value.signMessage({
              message: challenge.value.message,
              nonce: base64urlnopad.decode(challenge.value.nonce),
              recipient: challenge.value.recipient,
            }),
          (value) => walletNotice(value, "authorize"),
        );
        if (!signed.ok) {
          setError(signed.notice.text);
          return;
        }
        const exported = await exportRecoveryBackup({
          agentId,
          nonce: challenge.value.nonce,
          publicKey: signed.value.publicKey,
          signature: signed.value.signature,
        });
        if (!exported.ok) {
          setError(exported.message);
          return;
        }
        setMessage("Encrypting on your device…");
        const file = await sealRecoveryFile(exported.value.payload, password);
        downloadBackup(file);
        setConfirmation({
          accountId: exported.value.payload.accountId,
          token: exported.value.confirmationToken,
          fileHash: await recoveryFileHash(file),
          file,
        });
        form.reset();
        setMessage(
          "Save the recovery tool too, then confirm below. Keep your password separate from the backup.",
        );
      } catch {
        setError("The recovery backup could not be completed. Retry the ownership check.");
      }
    });
  }
  function confirm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!confirmation) {
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        const result = await confirmRecoveryBackup({
          accountId: confirmation.accountId,
          token: confirmation.token,
          fileHash: confirmation.fileHash,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        if (!result.value?.backupConfirmed) {
          setError("The trading account changed. Request a fresh recovery export.");
          return;
        }
        setConfirmed(true);
        setConfirmation(null);
        setMessage("Recovery backup confirmed.");
        notify("success", "Recovery backup confirmed.");
      } catch {
        setError("Confirmation could not be verified. Retry the same confirmation.");
      }
    });
  }
  if (agents.length === 0) {
    return <p className="text-small text-fg-muted">Save an agent before setting up a trading account.</p>;
  }
  const field =
    "min-h-11 w-full rounded-sm border border-line-strong bg-surface-1 px-3 text-small disabled:text-fg-disabled";
  return (
    <div className="space-y-4">
      <p className="text-small text-fg-muted">
        Vercel controls these funded accounts. Your encrypted backup lets you recover their keys without the
        app.
      </p>
      {confirmed ? <p className="text-small text-accent-text">Recovery backup confirmed.</p> : null}
      {!confirmation ? (
        <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
          <label className="flex flex-col gap-2 text-small">
            <span>Saved agent</span>
            <select name="agentId" required disabled={busy} defaultValue={agents[0]?.id} className={field}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-small">
              <span>Backup password · 12+ characters</span>
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                disabled={busy}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-2 text-small">
              <span>Repeat password</span>
              <input
                name="repeatPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                disabled={busy}
                className={field}
              />
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Preparing…" : confirmed ? "Download new backup" : "Save encrypted backup"}
          </Button>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-4" aria-busy={busy}>
          <Button type="button" disabled={busy} onClick={() => downloadBackup(confirmation.file)}>
            Download backup again
          </Button>
          <a
            href="/recovery-tool.html"
            download
            className="inline-flex min-h-11 items-center rounded-sm text-small text-accent-text underline underline-offset-4"
          >
            Save offline recovery tool
          </a>
          <label className="flex items-start gap-3 text-small">
            <input type="checkbox" required disabled={busy} className="mt-1 size-5 accent-accent" />
            <span>I saved the encrypted backup, recovery tool and password.</span>
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? "Confirming…" : "Confirm saved backup"}
          </Button>
        </form>
      )}
      {message && !error ? (
        <p role="status" className="text-small text-fg-muted">
          {message}
        </p>
      ) : null}
    </div>
  );
}
