export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="flex w-full max-w-reading flex-col gap-stack">
      <div className="h-10 w-40 rounded-sm bg-surface-2" aria-hidden="true" />
      {["Spending limit", "Telegram", "Trading access"].map((title) => (
        <div key={title} className="card-shine flex flex-col gap-5 rounded-lg p-card" aria-hidden="true">
          <div className="h-5 w-40 rounded-sm bg-surface-2" />
          <div className="h-11 w-full rounded-sm bg-surface-2" />
          <div className="h-10 w-28 rounded-sm bg-surface-2" />
        </div>
      ))}
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}
