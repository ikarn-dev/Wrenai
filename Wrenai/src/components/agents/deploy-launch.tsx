"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, LoaderCircle, Rocket } from "lucide-react";
import Link from "next/link";
import { type ReactElement, useRef, useState } from "react";
import { NativeFunding } from "@/components/trading/native-funding";
import { readTrading } from "@/components/trading/trading-api";
import { Button } from "@/components/ui/button";
import { agentRuntimeStatusSchema } from "@/shared/agent-runtime";
import { agentFundingStateSchema } from "@/shared/wallet-funding";
import { agentListKey } from "./agents-section";
import { agentCommandRequest } from "./review-api";
import { AgentWalletFunding, agentFundingKey } from "./wallet-funding";

const ICON = { size: 18, strokeWidth: 1.75, absoluteStrokeWidth: true, "aria-hidden": true } as const;

/** Server facts the deploy flow needs: who is signed in, whether this deployment can trade, and the recovery state. */
export interface LaunchContext {
  readonly ownerId: string;
  readonly accountId: string;
  readonly privateReady: boolean;
  readonly publicReady: boolean;
  readonly recoveryConfirmed: boolean;
}

interface DeployLaunchProps {
  readonly context: LaunchContext;
  readonly agent: { readonly id: string; readonly revision: number };
  readonly publicRoute: boolean;
  readonly budget: { readonly assetId: string; readonly amount: string } | null;
  /** Called once the setup is cancelled: the agent is deleted, or its funds are on their way back. */
  readonly onCancelled: () => void;
}

type StartState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The last part of Deploy: move the reserved budget to the agent with one wallet approval, then start it. After
 * this the agent page only needs Pause, Stop and Delete.
 */
export function DeployLaunch({
  context,
  agent,
  publicRoute,
  budget,
  onCancelled,
}: DeployLaunchProps): ReactElement {
  const cache = useQueryClient();
  const request = useRef<string | null>(null);
  const cancelRequest = useRef<string | null>(null);
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const [cancel, setCancel] = useState<{ readonly busy: boolean; readonly error: string | null }>({
    busy: false,
    error: null,
  });
  const ready = publicRoute ? context.publicReady : context.privateReady;
  // Shares the funding panel's query, so the Start button enables the moment funds arrive.
  const funding = useQuery({
    queryKey: agentFundingKey(context.ownerId, agent.id, agent.revision),
    queryFn: ({ signal }) =>
      readTrading(
        `/api/agents/${encodeURIComponent(agent.id)}?view=funding`,
        agentFundingStateSchema,
        signal,
      ),
    enabled: ready && !publicRoute,
    retry: false,
  });
  const funded = publicRoute || (funding.data !== undefined && funding.data.allocatedPrivateUnits !== "0");
  // The deposit left the wallet but hasn't reached the agent: nothing more for the user to add.
  const arriving =
    !funded &&
    (funding.data?.funding?.state === "deposited" || funding.data?.funding?.state === "converting");

  async function launch(): Promise<void> {
    setStart({ kind: "starting" });
    try {
      // Funding can advance the agent's revision, so start from the latest one.
      const status = await readTrading(
        `/api/agents/${encodeURIComponent(agent.id)}?view=runtime`,
        agentRuntimeStatusSchema,
        AbortSignal.timeout(15_000),
      );
      request.current ??= crypto.randomUUID();
      const result = await agentCommandRequest(agent.id, {
        requestId: request.current,
        agentId: agent.id,
        expectedRevision: status.agent.revision,
        command: "resume",
      });
      if (!result.ok) {
        request.current = null;
        setStart({ kind: "failed", message: result.message });
        return;
      }
      setStart({ kind: "running" });
      await cache.invalidateQueries({ queryKey: agentListKey(context.ownerId) });
    } catch (error) {
      request.current = null;
      setStart({
        kind: "failed",
        message: error instanceof Error ? error.message : "The agent couldn’t deploy. Try again.",
      });
    }
  }

  // Cancel setup deletes the agent. Anything already deposited goes back to the wallet first.
  async function cancelSetup(): Promise<void> {
    setCancel({ busy: true, error: null });
    try {
      const status = await readTrading(
        `/api/agents/${encodeURIComponent(agent.id)}?view=runtime`,
        agentRuntimeStatusSchema,
        AbortSignal.timeout(15_000),
      );
      cancelRequest.current ??= crypto.randomUUID();
      const result = await agentCommandRequest(agent.id, {
        requestId: cancelRequest.current,
        agentId: agent.id,
        expectedRevision: status.agent.revision,
        command: "delete",
      });
      if (!result.ok) {
        cancelRequest.current = null;
        setCancel({ busy: false, error: result.message });
        return;
      }
      await cache.invalidateQueries({ queryKey: agentListKey(context.ownerId) });
      onCancelled();
    } catch {
      cancelRequest.current = null;
      setCancel({ busy: false, error: "The setup couldn’t be cancelled. Try again." });
    }
  }

  if (!ready) {
    return (
      <p className="rounded-sm bg-warn-soft p-3 text-small text-warn">
        Adding funds and deploying are off in this copy. The agent is saved: set WRENAI_LOCAL_EXECUTION=1 and
        restart, or finish on the Vercel app.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {publicRoute ? (
        context.recoveryConfirmed && budget ? (
          <NativeFunding
            accountId={context.accountId}
            ready
            agent={{ id: agent.id, assetId: budget.assetId, amount: budget.amount }}
          />
        ) : (
          <p className="text-small text-fg-muted">
            Public-route agents trade from your trading account, which needs a recovery backup first.{" "}
            <Link href="/settings/recovery" className="text-accent-text underline-offset-4 hover:underline">
              Set it up in Settings
            </Link>
            , then create this agent again.
          </p>
        )
      ) : (
        <AgentWalletFunding
          agent={{ id: agent.id, revision: agent.revision, status: "paused" }}
          ownerId={context.ownerId}
          accountId={context.accountId}
          available={ready}
          framed={false}
        />
      )}
      {start.kind === "running" ? (
        <p role="status" className="flex items-center gap-2 text-small text-accent-text">
          <CircleCheck {...ICON} size={16} />
          Deployed. It runs on its own within your limits.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!funded || start.kind === "starting"}
            aria-busy={start.kind === "starting"}
            onClick={() => void launch()}
          >
            {start.kind === "starting" ? (
              <LoaderCircle {...ICON} className="motion-safe:animate-spin" />
            ) : (
              <Rocket {...ICON} />
            )}
            {start.kind === "starting" ? "Deploying…" : "Deploy agent"}
          </Button>
          <Button
            variant="ghost"
            disabled={cancel.busy || start.kind === "starting"}
            aria-busy={cancel.busy}
            onClick={() => void cancelSetup()}
          >
            {cancel.busy ? "Cancelling…" : arriving ? "Cancel and return" : "Cancel setup"}
          </Button>
          {funded ? null : (
            <p className="text-caption text-fg-subtle">
              {arriving ? "Deploy turns on when the funds arrive." : "Add the funds to deploy."}
            </p>
          )}
          {start.kind === "failed" || cancel.error ? (
            <p role="alert" className="w-full text-small text-warn">
              {start.kind === "failed" ? start.message : cancel.error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
