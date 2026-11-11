// Shown under the settings title on the first visit only: later tab switches happen on the client.
const BLOCK = "rounded-sm bg-surface-2 motion-safe:animate-pulse";

export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="flex flex-col gap-6 md:flex-row md:gap-10">
      <div aria-hidden="true" className="flex gap-1 md:w-48 md:shrink-0 md:flex-col">
        {["account", "trading", "recovery"].map((tab) => (
          <div key={tab} className={`h-9 w-28 md:w-full ${BLOCK}`} />
        ))}
      </div>
      <div aria-hidden="true" className="flex min-w-0 max-w-reading flex-1 flex-col gap-4">
        <div className={`h-6 w-32 ${BLOCK}`} />
        <div className="flex flex-col divide-y divide-line-card card-shine rounded-lg px-card">
          {["first", "second", "third"].map((row) => (
            <div key={row} className="flex items-center justify-between gap-8 py-4">
              <div className={`h-4 w-28 ${BLOCK}`} />
              <div className={`h-9 w-28 ${BLOCK}`} />
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}
