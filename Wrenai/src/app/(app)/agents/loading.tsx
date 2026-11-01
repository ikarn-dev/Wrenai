export default function AgentsLoading() {
  return (
    <div aria-busy="true" role="status" className="flex flex-col gap-8">
      <span className="sr-only">Loading agents</span>
      <div className="h-8 w-40 rounded-sm bg-surface-2" />
      <div className="grid gap-stack md:grid-cols-2 2xl:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="card-shine h-64 rounded-lg p-card motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}
