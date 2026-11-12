"use client";
import dynamic from "next/dynamic";
import type { ReactElement } from "react";
import { ActivitySkeleton } from "@/components/activity/skeleton";
import { AgentListSkeleton } from "@/components/agents/agent-list-skeleton";
import { JarvisLoading } from "@/components/chat/jarvis-mark";
import { TradingAccessSkeleton } from "@/components/portfolio/access-card";
import { PortfolioSkeleton } from "@/components/portfolio/portfolio-skeleton";
import { ProofIntro, ProofRecordsLoading } from "@/components/proof/proof-layout";
import { Button } from "@/components/ui/button";
import { NoticeBox } from "@/components/ui/status-line";
import { TestnetSettings } from "./account-pages";
import { TestnetActivity } from "./activity";
import { TestnetAgentDetail, TestnetAgentSkeleton } from "./agent-detail";
import { TestnetAgents } from "./agents";
import { TestnetClaims, TestnetClaimsSkeleton } from "./claims";
import { useTestnetData } from "./data-provider";
import { TestnetPortfolio } from "./portfolio";
import { TestnetProof } from "./proof";

const Chat = dynamic(() => import("./chat").then((m) => m.TestnetChat), { loading: () => <JarvisLoading /> });
const Spot = dynamic(() => import("@/components/trading/spot-screen").then((m) => m.SpotScreen));
const Perps = dynamic(() => import("@/components/trading/perps-screen").then((m) => m.PerpsScreen));
const Memecoins = dynamic(() =>
  import("@/components/trading/memecoins-screen").then((m) => m.MemecoinsScreen),
);
export function TestnetPageView({
  section,
  id,
}: {
  readonly section: string;
  readonly id?: string | undefined;
}): ReactElement | null {
  const { data, error, refresh } = useTestnetData();
  if (error && !data) {
    return (
      <div className="flex flex-col gap-4">
        <NoticeBox notice={{ tone: "warn", text: error.message }} />
        <Button
          variant="soft"
          onClick={() => {
            void refresh();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!data) {
    return section === "chat" ? (
      <JarvisLoading />
    ) : section === "agents" ? (
      id ? (
        <TestnetAgentSkeleton />
      ) : (
        <AgentListSkeleton />
      )
    ) : section === "activity" ? (
      <div className="flex min-w-0 flex-col gap-8">
        <h1 className="font-display text-page-title">Activity</h1>
        <ActivitySkeleton />
      </div>
    ) : section === "proof" ? (
      // Same layout as the mainnet Proof page while it loads.
      <div className="flex flex-col gap-8">
        <ProofIntro loading />
        <ProofRecordsLoading />
      </div>
    ) : section === "claims" ? (
      <TestnetClaimsSkeleton />
    ) : section === "portfolio" ? (
      <PortfolioSkeleton testnet />
    ) : (
      <div className="grid min-h-80 gap-stack lg:grid-cols-2">
        <TradingAccessSkeleton />
        <TradingAccessSkeleton />
      </div>
    );
  }
  switch (section) {
    case "portfolio":
      return <TestnetPortfolio />;
    case "agents":
      return id ? <TestnetAgentDetail id={id} /> : <TestnetAgents />;
    case "chat":
      return <Chat />;
    case "activity":
      return (
        <div className="flex min-w-0 flex-col gap-8">
          <h1 className="font-display text-page-title">Activity</h1>
          <TestnetActivity full />
        </div>
      );
    case "claims":
      return <TestnetClaims />;
    case "proof":
      return <TestnetProof />;
    case "settings":
      return <TestnetSettings />;
    case "spot":
      return <Spot />;
    case "perps":
      return <Perps accountId={data.owner.accountId ?? "Guest"} />;
    case "memecoins":
      return <Memecoins />;
    default:
      return null;
  }
}
