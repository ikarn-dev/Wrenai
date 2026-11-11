import type { Metadata } from "next";
import { type ReactElement, Suspense } from "react";
import { AgentsHeader } from "@/components/agents/agents-header";
import { AgentsSection } from "@/components/agents/agents-section";
import { AgentCatalog } from "@/components/agents/catalog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { type CreateAgentQuery, resolveCreateRequest } from "@/server/agents/create-request";
import { deployedRuntimeReady } from "@/server/agents/readiness";
import { requireUser, type SessionUser } from "@/server/auth/session";
import { database } from "@/server/db/client";
import { tradingAccountSummary } from "@/server/trading-accounts/vault";
import { needsServerRequest } from "@/shared/agent-create-request";

export const metadata: Metadata = { title: "Agents" };

async function CreateDialog({
  user,
  searchParams,
}: {
  readonly user: SessionUser;
  readonly searchParams: Promise<CreateAgentQuery>;
}): Promise<ReactElement> {
  const [query, recovery] = await Promise.all([searchParams, tradingAccountSummary(database(), user.id)]);
  // Always mounted: a bare `?create=<type>` opens in the browser without a server request.
  const server = needsServerRequest({ get: (name) => (query[name] === undefined ? null : "") });
  return (
    <CreateAgentDialog
      request={server ? await resolveCreateRequest(user.id, query) : null}
      launch={{
        ownerId: user.id,
        accountId: user.accountId,
        privateReady: deployedRuntimeReady(),
        publicReady: deployedRuntimeReady(true),
        recoveryConfirmed: recovery?.backupConfirmed ?? false,
      }}
    />
  );
}

export default async function AgentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<CreateAgentQuery>;
}): Promise<ReactElement> {
  const user = await requireUser();
  return (
    <div className="flex min-w-0 flex-col gap-12">
      <AgentsHeader />
      <AgentsSection ownerId={user.id} />
      <AgentCatalog />
      <Suspense fallback={null}>
        <CreateDialog user={user} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
