"use client";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { createContext, type ReactNode, useContext } from "react";
import { type TestnetSnapshot, testnetSnapshotSchema } from "@/shared/testnet";
import { testnetApi } from "./api";

interface TestnetData {
  readonly data: TestnetSnapshot | undefined;
  readonly error: Error | null;
  readonly refresh: () => Promise<unknown>;
}
const DataContext = createContext<TestnetData | null>(null);
function snapshotQuery(ownerId: string) {
  return {
    queryKey: ["testnet", ownerId],
    queryFn: async () => {
      const data = testnetSnapshotSchema.parse(await testnetApi());
      if (data.owner.id !== ownerId) {
        throw new Error("Your testnet session changed. Reload to continue.");
      }
      return data;
    },
    refetchIntervalInBackground: false,
    retry: false,
  } as const;
}
/**
 * Refreshes the shared snapshot every five seconds while `active` (an agent page with a live agent), on top of the
 * provider's 15 second refresh. Same query, so every screen sees the same data.
 */
export function useTestnetLivePolling(ownerId: string | null, active: boolean): void {
  useQuery({
    ...snapshotQuery(ownerId ?? ""),
    enabled: ownerId !== null,
    staleTime: 4000,
    refetchInterval: active ? 5000 : false,
  });
}
export function TestnetDataProvider({
  ownerId,
  children,
}: {
  readonly ownerId: string;
  readonly children: ReactNode;
}): ReactElement | null {
  const query = useQuery({ ...snapshotQuery(ownerId), staleTime: 15000, refetchInterval: 15000 });
  return (
    <DataContext.Provider value={{ data: query.data, error: query.error, refresh: query.refetch }}>
      {children}
    </DataContext.Provider>
  );
}
export function useTestnetData(): TestnetData {
  const data = useContext(DataContext);
  if (!data) {
    throw new Error("Testnet data requires the authenticated app layout.");
  }
  return data;
}
