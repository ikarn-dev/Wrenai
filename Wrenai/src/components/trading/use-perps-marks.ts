"use client";
import { useEffect, useState } from "react";
import { readPerpsMarkFrame } from "./perps-mark-feed";

const ENDPOINT = "wss://api.hyperliquid.xyz/ws";
const SUBSCRIBE = JSON.stringify({ method: "subscribe", subscription: { type: "fastAssetCtxs" } });
const FRAME_WAIT_MS = 10_000;
const PUBLISH_MS = 400;
const RECONNECT_MIN_MS = 2000;

/** One public connection for the visible Perps view. Only display values use this feed. */
export function usePerpsMarks(enabled: boolean): ReadonlyMap<string, string> | null {
  const [latest, setLatest] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined" || typeof DecompressionStream === "undefined") {
      return;
    }
    try {
      new DecompressionStream("deflate-raw");
    } catch {
      return;
    }
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let publish: ReturnType<typeof setTimeout> | undefined;
    let backoff = RECONNECT_MIN_MS;

    function stop(): void {
      clearTimeout(reconnect);
      clearTimeout(watchdog);
      clearTimeout(publish);
      publish = undefined;
      const connection = socket;
      socket = undefined;
      connection?.close();
      setLatest(null);
    }

    function connect(): void {
      if (document.hidden || socket) {
        return;
      }
      let connection: WebSocket;
      try {
        connection = new WebSocket(ENDPOINT);
      } catch {
        return;
      }
      const startedAt = Date.now();
      socket = connection;
      const marks = new Map<string, string>();
      let pending = Promise.resolve();
      let queued = 0;
      const resetDeadline = (): void => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => connection.close(), FRAME_WAIT_MS);
      };
      resetDeadline();
      connection.onopen = () => {
        if (socket === connection) {
          connection.send(SUBSCRIBE);
        }
      };
      connection.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (socket !== connection) {
          return;
        }
        if (++queued > 16) {
          connection.close();
          return;
        }
        pending = pending
          .then(async () => {
            if (socket !== connection) {
              return;
            }
            const updates = await readPerpsMarkFrame(data);
            if (socket !== connection || !updates?.size) {
              return;
            }
            if (Date.now() - startedAt >= FRAME_WAIT_MS) {
              backoff = RECONNECT_MIN_MS;
            }
            resetDeadline();
            let changed = false;
            for (const [name, mark] of updates) {
              if ((marks.has(name) || marks.size < 2000) && marks.get(name) !== mark) {
                marks.set(name, mark);
                changed = true;
              }
            }
            if (changed) {
              publish ??= setTimeout(() => {
                publish = undefined;
                setLatest(new Map(marks));
              }, PUBLISH_MS);
            }
          })
          .catch(() => connection.close())
          .finally(() => {
            queued--;
          });
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        if (socket !== connection) {
          return;
        }
        stop();
        if (!document.hidden) {
          reconnect = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15_000);
        }
      };
    }

    const visibility = (): void => {
      if (document.hidden) {
        stop();
      } else {
        connect();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      stop();
    };
  }, [enabled]);
  return enabled ? latest : null;
}
