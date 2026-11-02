// Wraps each tab inside the settings layout, so the title and tabs stay put while a tab loads.
export default function SettingsLoading() {
  return (
    <div role="status" aria-label="Loading settings" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className="h-6 w-36 rounded-sm bg-surface-2" />
        <div className="h-4 w-64 rounded-sm bg-surface-2" />
      </div>
      <div
        className="flex flex-col divide-y divide-line-card card-shine rounded-lg px-card"
        aria-hidden="true"
      >
        {["first", "second", "third"].map((row) => (
          <div key={row} className="flex items-center justify-between gap-8 py-5">
            <div className="flex flex-col gap-2">
              <div className="h-4 w-32 rounded-sm bg-surface-2" />
              <div className="h-3.5 w-52 rounded-sm bg-surface-2" />
            </div>
            <div className="h-10 w-28 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}
