"use client";

import type { ReactElement } from "react";
import { ActivityFeedView } from "@/components/activity/feed";
import { type ActivitySource, useActivityPages } from "@/components/activity/use-activity-pages";
import type { ActivityResult } from "@/shared/activity";
import { loadTestnetActivity } from "./activity-api";
import { useTestnetData } from "./data-provider";

// No server-rendered first page on testnet: the table shows its skeleton until the first read lands.
const NO_INITIAL: ActivityResult = { ok: false, code: "unavailable", message: "" };

/**
 * Testnet activity with the mainnet feed: the same paging, filters and table, read from GET /api/testnet/activity
 * (the session, agents, confirmed orders and, for a connected wallet, its NearBlocks testnet history). When the
 * polled snapshot shows an agent or order changed, the newest page reloads on its own.
 */
export function TestnetActivity({ full = false }: { readonly full?: boolean }): ReactElement {
  const { data } = useTestnetData();
  const ownerId = data?.owner.id ?? "pending";
  const version = [
    ...(data?.agents.map((agent) => `${agent.id}:${agent.state}`) ?? []),
    ...(data?.orders.map((order) => `${order.id}:${order.state}:${order.txHash ?? ""}`) ?? []),
  ].join("|");
  const source: ActivitySource = {
    scope: "testnet-activity",
    load: ({ filter, cursor }) => loadTestnetActivity({ filter, cursor }),
    version,
  };
  const activity = useActivityPages(ownerId, NO_INITIAL, source);
  return <ActivityFeedView testnet full={full} activity={activity} />;
}
