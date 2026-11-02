import type { Metadata } from "next";
import { SettingsPanel, SettingsRow } from "@/components/settings/section";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { NoticeBox } from "@/components/ui/status-line";
import { AgentKeyDialog } from "@/components/wallet/agent-key-dialog";
import { KEY_NOT_CHECKED } from "@/components/wallet/notices";
import { RevokeKeyDialog } from "@/components/wallet/revoke-key-dialog";
import { requireUser } from "@/server/auth/session";
import { type DelegatedKeyState, readDelegatedKey } from "@/server/delegation/delegated-key";
import { middleTruncate } from "@/shared/truncate";

export const metadata: Metadata = { title: "Trading access" };

const ACTIVE_SINCE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const STATUS: Readonly<
  Record<
    DelegatedKeyState["kind"],
    { readonly label: string; readonly tone: BadgeTone; readonly text: string }
  >
> = {
  active: { label: "Active", tone: "accent", text: "Authorized on your Intents account." },
  pending: { label: "Pending", tone: "warn", text: "Started, but not confirmed on NEAR yet." },
  none: { label: "Not authorized", tone: "neutral", text: "Only needed before an agent executes." },
};

export default async function TradingAccessSettingsPage() {
  const user = await requireUser();
  const { state, checked } = await readDelegatedKey(user);
  const status = STATUS[state.kind];
  return (
    <SettingsPanel
      title="Trading access"
      description="One shared Intents authorization, active until you revoke it."
    >
      <SettingsRow label="Status" description={status.text}>
        <Badge tone={status.tone} dot>
          {status.label}
        </Badge>
      </SettingsRow>
      {state.kind === "active" ? (
        <SettingsRow
          label="Agent key"
          description={`Active since ${ACTIVE_SINCE.format(state.activatedAt)} UTC`}
        >
          <div className="flex items-center gap-3">
            <p className="font-mono text-small text-fg-strong" title={state.publicKey}>
              <span aria-hidden="true">{middleTruncate(state.publicKey, 12, 6)}</span>
              <span className="sr-only">{state.publicKey}</span>
            </p>
            <RevokeKeyDialog accountId={user.accountId} publicKey={state.publicKey} />
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow label="Agent key" description="Create and review agents first, then set up access.">
          <AgentKeyDialog accountId={user.accountId} />
        </SettingsRow>
      )}
      {checked ? null : (
        <div className="py-5">
          <NoticeBox notice={KEY_NOT_CHECKED} />
        </div>
      )}
    </SettingsPanel>
  );
}
