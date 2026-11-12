"use client";
import { HandCoins, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CELL } from "@/components/activity/row";
import { columnAlign } from "@/components/activity/table";
import { AgentAvatar } from "@/components/agents/avatar";
import { Amounts, BadgeButton } from "@/components/claims/claim-cells";
import { STICKY } from "@/components/claims/claim-row";
import { ClaimsEmptyState } from "@/components/claims/claims-table";
import { Badge } from "@/components/ui/badge";
import type { ClaimAmount } from "@/shared/claims";
import { type TestnetSnapshot, testnetAsset } from "@/shared/testnet";
import { parseTokenAmount } from "@/shared/token-units";
import { testnetApi } from "./api";
import { useTestnetData } from "./data-provider";

type Agent = TestnetSnapshot["agents"][number];
const COLUMNS = ["Agent", "Deposited", "Claimable", "Held by orders", "Status", ""] as const;
const ROW = "border-t border-line-card align-middle text-small";
const STATUS: Readonly<Record<string, string>> = {
  running: "Running",
  stopped: "Stopped",
  completed: "Completed",
  blocked: "Needs review",
  deleted: "Deleted",
};

/** Per-token sums across balance locations; zero amounts are left out. */
function amounts(agent: Agent, pick: (h: Agent["holdings"][number]) => bigint): readonly ClaimAmount[] {
  const totals = new Map<string, bigint>();
  for (const h of agent.holdings) {
    totals.set(h.assetId, (totals.get(h.assetId) ?? 0n) + pick(h));
  }
  return [...totals]
    .filter(([, units]) => units > 0n)
    .map(([assetId, units]) => {
      const asset = testnetAsset(assetId);
      return { assetId, symbol: asset.symbol, decimals: asset.decimals, units: units.toString() };
    });
}

function ClaimRow({ agent }: { readonly agent: Agent }): ReactElement {
  const { refresh } = useTestnetData(),
    [busy, setBusy] = useState(false);
  const asset = testnetAsset(agent.rule.assetId);
  const free = amounts(agent, (h) => BigInt(h.units) - BigInt(h.held)),
    held = amounts(agent, (h) => BigInt(h.held));
  async function claim(): Promise<void> {
    setBusy(true);
    try {
      await testnetApi({ command: "claim", id: agent.id });
      await refresh();
      toast.success("Funds returned to your test balance.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not claim these funds.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr className={ROW}>
      <td className={`${CELL} ${STICKY} max-w-60`}>
        <span className="flex min-w-0 items-center gap-2.5">
          <AgentAvatar running={agent.state === "running"} size={24} />
          {agent.state === "deleted" ? (
            <span className="truncate font-medium text-fg-strong">{agent.name}</span>
          ) : (
            <Link
              href={`/testnet/agents/${agent.id}`}
              className="truncate font-medium text-fg-strong hover:underline"
            >
              {agent.name}
            </Link>
          )}
        </span>
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <span className="flex justify-center">
          <Amounts
            amounts={[
              {
                assetId: asset.id,
                symbol: asset.symbol,
                decimals: asset.decimals,
                units: parseTokenAmount(agent.rule.budget, asset.decimals).toString(),
              },
            ]}
          />
        </span>
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <span className="flex justify-center">
          <Amounts amounts={free} />
        </span>
      </td>
      <td className={`${CELL} text-center font-mono tabular-nums`}>
        <span className="flex justify-center">
          <Amounts amounts={held} />
        </span>
      </td>
      <td className={`${CELL} whitespace-nowrap text-center`}>
        <Badge
          tone={agent.state === "running" ? "accent" : agent.state === "blocked" ? "warn" : "neutral"}
          dot
        >
          {STATUS[agent.state] ?? agent.state}
        </Badge>
      </td>
      <td className={`${CELL} whitespace-nowrap text-right`}>
        <span className="flex flex-col items-end gap-1">
          {free.length ? (
            <BadgeButton
              tone="accent"
              icon={busy ? LoaderCircle : HandCoins}
              busy={busy}
              onClick={() => {
                void claim();
              }}
            >
              Claim
            </BadgeButton>
          ) : (
            <span className="text-caption text-fg-muted">Returns when its orders settle</span>
          )}
        </span>
      </td>
    </tr>
  );
}

function ClaimsTable({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="overflow-x-auto overscroll-x-contain border-b border-line-card">
      <table aria-label="Pending claims" className="w-full min-w-4xl table-fixed border-collapse">
        <thead>
          <tr>
            {COLUMNS.map((label, position) => (
              <th
                key={label || "action"}
                scope="col"
                className={`${CELL} py-2.5 font-mono text-eyebrow font-medium whitespace-nowrap text-fg-subtle uppercase ${columnAlign(position, COLUMNS.length)} ${position === 0 ? `${STICKY} w-1/4` : ""}`}
              >
                {label || <span className="sr-only">Action</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** The loaded page's title and table head with one pulsing row, like mainnet's claims while it loads. */
export function TestnetClaimsSkeleton(): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Claims</h1>
      <ClaimsTable>
        <tr>
          <td colSpan={COLUMNS.length} className={CELL}>
            <span
              role="status"
              aria-label="Loading claims"
              className="block h-10 rounded-xs bg-surface-2 motion-safe:animate-pulse"
            />
          </td>
        </tr>
      </ClaimsTable>
    </div>
  );
}

/**
 * Testnet Claims, like mainnet: stopped and deleted agents keep their funds until claimed. A claim returns the free
 * units to the guest's test balance; units held by unsettled orders stay until those orders settle.
 */
export function TestnetClaims(): ReactElement | null {
  const { data } = useTestnetData();
  const agents = (data?.agents ?? []).filter((a) => a.holdings.length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <h1 className="font-display text-page-title">Claims</h1>
      {agents.length ? (
        <ClaimsTable>
          {agents.map((agent) => (
            <ClaimRow key={agent.id} agent={agent} />
          ))}
        </ClaimsTable>
      ) : (
        <ClaimsEmptyState error={null} />
      )}
    </div>
  );
}
