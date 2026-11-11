"use client";
import { base64urlnopad } from "@scure/base";
import { ChevronDown, Download } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
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
import { FIELD, PasswordField } from "./password-field";

const ICON = { "aria-hidden": true, size: 16, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

interface Confirmation {
  readonly accountId: string;
  readonly token: string;
  readonly fileHash: string;
  readonly file: string;
}

function downloadBackup(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "wrenai-encrypted-recovery.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The trading account to back up. With no agents there is only the manual account, so no picker is shown. */
function AccountPicker({
  agents,
  disabled,
}: {
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly disabled: boolean;
}): ReactElement {
  const id = useId();
  if (agents.length === 0) {
    return <input type="hidden" name="agentId" value="manual" />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small text-fg-muted">
        Account
      </label>
      <div className="relative">
        <select
          id={id}
          name="agentId"
          required
          disabled={disabled}
          defaultValue="manual"
          className={`${FIELD} cursor-pointer appearance-none pr-10`}
        >
          <option value="manual">Manual Spot and Perps</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <ChevronDown
          {...ICON}
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-subtle"
        />
      </div>
    </div>
  );
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
  const [confirmed, setConfirmed] = useState(initial?.derivedBackupConfirmed ?? false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
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
      setMessage("Checking ownership…");
      try {
        const context = agentId === "manual" ? { manual: true as const } : { agentId };
        const challenge = await requestRecoveryBackup(context);
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
        setMessage("Approve in your wallet…");
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
          ...context,
          nonce: challenge.value.nonce,
          publicKey: signed.value.publicKey,
          signature: signed.value.signature,
        });
        if (!exported.ok) {
          setError(exported.message);
          return;
        }
        setMessage("Encrypting on this device…");
        const file = await sealRecoveryFile(exported.value.payload, password);
        downloadBackup(file);
        setConfirmation({
          accountId: exported.value.payload.accountId,
          token: exported.value.confirmationToken,
          fileHash: await recoveryFileHash(file),
          file,
        });
        form.reset();
        setMessage("Downloaded. Keep the password apart from the file.");
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
        if (!result.value?.derivedBackupConfirmed) {
          setError("The trading account changed. Request a fresh recovery export.");
          return;
        }
        setConfirmed(true);
        setConfirmation(null);
        setMessage(null);
        notify("success", "Recovery backup confirmed.");
      } catch {
        setError("Confirmation could not be verified. Retry the same confirmation.");
      }
    });
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-small text-fg-muted">
          The server holds these keys. This file recovers them without the app.
        </p>
        {confirmed ? (
          <Badge tone="accent" dot>
            Backed up
          </Badge>
        ) : initial?.backupConfirmed ? (
          <Badge tone="warn" dot>
            Update needed
          </Badge>
        ) : null}
      </div>
      {!confirmation ? (
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <AccountPicker agents={agents} disabled={busy} />
          <div className="grid gap-4 sm:grid-cols-2">
            <PasswordField name="password" label="Password" placeholder="12+ characters" disabled={busy} />
            <PasswordField name="repeatPassword" label="Repeat password" disabled={busy} />
          </div>
          <div>
            <Button type="submit" variant="primary" busy={busy}>
              <Download {...ICON} />
              {confirmed ? "Download new backup" : "Save backup"}
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={confirm} className="flex flex-col gap-4" aria-busy={busy}>
          <label className="flex cursor-pointer items-start gap-3 text-small text-fg">
            <input type="checkbox" required disabled={busy} className="mt-0.5 size-4 accent-accent" />
            <span>I saved the file and its password.</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" busy={busy}>
              Confirm backup
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => downloadBackup(confirmation.file)}>
              <Download {...ICON} />
              Download again
            </Button>
          </div>
          <details className="text-small text-fg-muted">
            <summary className="w-fit cursor-pointer rounded-xs text-fg-muted transition-colors duration-200 ease-ios hover:text-fg-strong">
              Recover offline
            </summary>
            <p className="mt-2">
              From a copy of the project, run{" "}
              <code className="font-mono">pnpm recover backup.json recovered.key</code>. Add an agent index
              for its Perps address. It asks for the password locally.
            </p>
          </details>
        </form>
      )}
      {/* Always present, so screen readers announce each step. */}
      <p role="status" aria-live="polite" className="min-h-0 text-small text-fg-muted empty:hidden">
        {message && !error ? message : ""}
      </p>
    </div>
  );
}
