"use client";
import { useRouter } from "next/navigation";
import { type ReactElement, useState, useTransition } from "react";
import { createChatAgentSetup } from "@/server/chat/draft-actions";
import { AGENT_CATALOG } from "@/shared/agent-catalog";
import type { ResearchReport } from "@/shared/research";

export function ResearchCards({
  reports,
  source,
}: {
  readonly reports: readonly ResearchReport[];
  readonly source?: { readonly conversationId: string; readonly turnId: string };
}): ReactElement {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const tools = [...new Set(reports.map((report) => report.tool))];
  return (
    <div className="mt-5 space-y-4">
      {tools.map((tool) => {
        const report = reports.filter((item) => item.tool === tool).at(-1);
        if (!report) {
          return null;
        }
        return (
          <section key={tool} className="min-w-0 rounded-md border border-line-subtle bg-surface-1 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-small font-medium">{AGENT_CATALOG[tool].name}</h3>
              <span className="text-caption text-fg-subtle">
                {report.status === "unavailable" ? "Data unavailable" : "Research snapshot"}
              </span>
            </div>
            <details className="mt-3 text-small">
              <summary className="min-h-10 cursor-pointer rounded-sm py-2 text-accent-text">
                Data and sources
              </summary>
              <p className="mt-2 text-small leading-relaxed text-fg-muted">{report.summary}</p>
              <div className="space-y-4 pt-2">
                {report.items.slice(0, 5).map((item) => (
                  <div key={item.id} className="border-t border-line-subtle pt-3">
                    <p className="break-words font-medium">
                      {item.title}{" "}
                      <span className="text-caption font-normal text-fg-subtle">
                        · {item.status.replaceAll("_", " ")}
                      </span>
                    </p>
                    <dl className="mt-2 grid gap-2">
                      {item.metrics.map((metric) => (
                        <div key={metric.label} className="grid min-w-0 gap-1 sm:grid-cols-2 sm:gap-4">
                          <dt className="text-caption text-fg-subtle">{metric.label}</dt>
                          <dd className="break-all font-mono text-caption text-fg-muted tabular-nums sm:text-right">
                            {metric.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-caption leading-relaxed text-fg-subtle">{item.note}</p>
                  </div>
                ))}
              </div>
              {report.assessment ? (
                <div className="mt-4 space-y-2">
                  <p className="font-medium">{report.assessment.summary}</p>
                  {report.assessment.reasons.map((reason) => (
                    <p key={reason} className="text-caption text-fg-muted">
                      {reason}
                    </p>
                  ))}
                  {report.assessment.conditions.map((condition) => (
                    <p key={condition} className="text-caption text-fg-subtle">
                      {condition}
                    </p>
                  ))}
                </div>
              ) : null}
              {report.news ? (
                <div className="mt-4 space-y-2">
                  <h4 className="text-small font-medium">News context</h4>
                  <p className="text-caption text-fg-subtle">
                    {report.news.status === "not_configured"
                      ? "News search is not configured. This view uses market data only."
                      : report.news.note}
                  </p>
                  {report.news.articles.map((article) => (
                    <div key={article.id} className="text-caption">
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-text hover:underline"
                      >
                        {article.title}
                      </a>
                      <p className="mt-1 text-fg-subtle">
                        {article.pageDate
                          ? `Page date: ${new Date(article.pageDate).toISOString().slice(0, 10)}`
                          : "Page date unverified"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
              <ul className="mt-4 space-y-2">
                {report.sources.map((item) => (
                  <li key={item.id} className="text-caption text-fg-subtle">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-sm text-accent-text hover:underline"
                    >
                      {item.label}
                    </a>{" "}
                    · {new Date(item.observedAt).toISOString().replace("T", " ").slice(0, 19)} UTC
                    {item.blockHeight ? ` · block ${item.blockHeight.toLocaleString("en")}` : ""}
                  </li>
                ))}
              </ul>
              {report.limitations.map((note) => (
                <p key={note} className="mt-2 text-caption text-fg-subtle">
                  {note}
                </p>
              ))}
            </details>
            {source && report.status !== "unavailable" ? (
              <button
                type="button"
                disabled={busy}
                className="mt-3 min-h-11 cursor-pointer rounded-sm px-3 text-small text-accent-text hover:bg-surface-2 disabled:cursor-progress"
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    try {
                      const result = await createChatAgentSetup({ ...source, tool });
                      if (!result.ok) {
                        setError(result.message);
                        return;
                      }
                      router.push(`/agents/setup/${result.value.id}`);
                    } catch {
                      setError("The setup could not be saved. Try again.");
                    }
                  });
                }}
              >
                {busy ? "Saving setup…" : "Create agent"}
              </button>
            ) : null}
          </section>
        );
      })}
      {error ? (
        <p role="alert" className="text-small text-warn">
          {error}
        </p>
      ) : null}
    </div>
  );
}
