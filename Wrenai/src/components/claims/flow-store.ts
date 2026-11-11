"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { ClaimRecovery, ClaimRow } from "@/shared/claims";

export type ClaimFlow = ClaimRecovery;

interface Store<T> {
  readonly get: () => T;
  readonly set: (value: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Per Claims screen: which row's claim dialog is open, and the confirmed private claims in progress. */
export interface ClaimsStore {
  readonly selected: Store<ClaimRow | null>;
  readonly flows: Store<readonly ClaimFlow[]>;
}

export function createClaimsStore(): ClaimsStore {
  return { selected: createStore<ClaimRow | null>(null), flows: createStore<readonly ClaimFlow[]>([]) };
}

export const ClaimsContext = createContext<ClaimsStore | null>(null);

export function useClaimsStore(): ClaimsStore {
  const store = useContext(ClaimsContext);
  if (store === null) {
    throw new Error("Claim controls render inside the Claims table.");
  }
  return store;
}

/** Subscribes to one slice, so a dialog or a flow change re-renders only the components that read it. */
export function useStoreValue<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function addFlow(store: ClaimsStore, flow: ClaimFlow): void {
  store.flows.set([...store.flows.get().filter((item) => item.id !== flow.id), flow]);
}

export function removeFlow(store: ClaimsStore, id: string): void {
  store.flows.set(store.flows.get().filter((item) => item.id !== id));
}
