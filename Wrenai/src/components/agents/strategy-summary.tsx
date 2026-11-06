import type { ReactElement } from "react";
import { agentSetupProfile } from "@/shared/agent-templates";
import { type AgentPolicy, parseUsd, type Strategy } from "@/shared/agents";
import { formatExactMicroUsd } from "@/shared/money";
import type { TradeAsset } from "@/shared/trade-preview";
import { InstructionSummary } from "./instruction-summary";

export const APPROVAL_LABELS = {
  autonomous: "Autonomous within limits",
  above_size: "Approve above a size",
  every_action: "Approve every action",
} as const;

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-small text-fg-muted">{label}</dt>
      <dd className="text-right text-small text-fg-strong">{children}</dd>
    </div>
  );
}

export function StrategySummary({
  strategy,
  assets = [],
}: {
  readonly strategy: Strategy;
  readonly assets?: readonly TradeAsset[] | undefined;
}): ReactElement {
  if ("format" in strategy) {
    return <InstructionSummary instruction={strategy} assets={assets} />;
  }
  return (
    <dl className="divide-y divide-line/60">
      {strategy.kind === "rebalancer" ? (
        <>
          {strategy.targets.map((target) => (
            <Detail key={target.symbol} label={target.symbol}>
              <span className="font-mono tabular-nums">{target.weightBps / 100}%</span> target
            </Detail>
          ))}
          <Detail label="Drift band">{strategy.driftBps / 100}%</Detail>
          <Detail label="Check interval">{strategy.intervalSeconds} seconds</Detail>
        </>
      ) : strategy.kind === "copy_trading" ? (
        <>
          <Detail label="Public leader">{strategy.leaderAccountId}</Detail>
          <Detail label="Reviewed assets">{strategy.assets.join(" / ")}</Detail>
          <Detail label="Copy size">{formatExactMicroUsd(parseUsd(strategy.orderSizeUsd))}</Detail>
          <Detail label="Maximum signal age">
            <span className="font-mono tabular-nums">{strategy.maxSignalAgeSeconds}</span> seconds
          </Detail>
          <Detail label="Maximum price deviation">
            <span className="font-mono tabular-nums">{strategy.maxPriceDeviationBps}</span> bps
          </Detail>
          <Detail label="Check interval">60 seconds · best effort</Detail>
          <Detail label="Expires (UTC)">
            {new Date(strategy.expiresAt).toISOString().slice(0, 16).replace("T", " ")}
          </Detail>
        </>
      ) : (
        <>
          <Detail label="Trading pair">
            {strategy.asset} / {strategy.quoteAsset}
          </Detail>
          <Detail label={strategy.condition === "buy_above" ? "Buy above" : "Buy below"}>
            {formatExactMicroUsd(parseUsd(strategy.triggerPriceUsd))}
          </Detail>
          <Detail label="Order size">{formatExactMicroUsd(parseUsd(strategy.orderSizeUsd))}</Detail>
          <Detail label="Take profit">
            {strategy.takeProfitPriceUsd === null
              ? "Not set"
              : formatExactMicroUsd(parseUsd(strategy.takeProfitPriceUsd))}
          </Detail>
          <Detail label="Stop loss">
            {strategy.stopLossPriceUsd === null
              ? "Not set"
              : formatExactMicroUsd(parseUsd(strategy.stopLossPriceUsd))}
          </Detail>
          <Detail label="Trailing stop">
            {strategy.trailingStopBps === null ? "Not set" : `${strategy.trailingStopBps / 100}%`}
          </Detail>
          <Detail label="Maximum chase">{strategy.maxChaseBps / 100}%</Detail>
          <Detail label="Confirmation">
            {strategy.confirmationSeconds === 0 ? "Immediate" : `${strategy.confirmationSeconds} seconds`}
          </Detail>
          <Detail label="After exit">{strategy.rearm ? "Re-arm" : "Stop"}</Detail>
          <Detail label="Expires (UTC)">
            {new Date(strategy.expiresAt).toISOString().slice(0, 16).replace("T", " ")}
          </Detail>
        </>
      )}
    </dl>
  );
}

export function PolicySummary({
  pack,
  policy,
}: {
  readonly pack: string;
  readonly policy: AgentPolicy;
}): ReactElement {
  const profile = agentSetupProfile(pack);
  const payment = pack === "private_payments";
  return (
    <dl className="divide-y divide-line/60">
      <Detail label="Capital ceiling">{formatExactMicroUsd(parseUsd(policy.budgetUsd))}</Detail>
      <Detail label={`Per ${profile.action}`}>{formatExactMicroUsd(parseUsd(policy.maxTradeUsd))}</Detail>
      <Detail label="24-hour cap">{formatExactMicroUsd(parseUsd(policy.dailyCapUsd))}</Detail>
      <Detail label="Approval">{APPROVAL_LABELS[policy.approvalMode]}</Detail>
      {policy.approvalMode === "above_size" ? (
        <Detail label="Approval threshold">
          {formatExactMicroUsd(parseUsd(policy.approvalThresholdUsd))}
        </Detail>
      ) : null}
      <Detail label={payment ? "Quote tolerance" : "Slippage cap"}>{policy.maxSlippageBps / 100}%</Detail>
      <Detail label="Provider fee cap">{policy.maxProviderFeeBps} bps</Detail>
      {payment ? null : (
        <>
          <Detail label={`Max ${profile.actions} per hour`}>{policy.maxTradesPerHour}</Detail>
          <Detail label="Cooldown">{policy.cooldownSeconds} seconds</Detail>
        </>
      )}
      {profile.protectiveExits && policy.allowRiskReducingExits === true ? (
        <Detail label="Protective exits">Owned position only · independent of entry spending caps</Detail>
      ) : null}
    </dl>
  );
}
