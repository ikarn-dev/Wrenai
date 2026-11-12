"use client";
import type { ReactElement } from "react";
import { createContext, type ReactNode, useContext } from "react";
import type { AppNetwork } from "@/shared/network";

const NetworkContext = createContext<AppNetwork>("mainnet");
export function AppNetworkProvider({
  network,
  children,
}: {
  readonly network: AppNetwork;
  readonly children: ReactNode;
}): ReactElement | null {
  return <NetworkContext.Provider value={network}>{children}</NetworkContext.Provider>;
}
export function useAppNetwork(): AppNetwork {
  return useContext(NetworkContext);
}
