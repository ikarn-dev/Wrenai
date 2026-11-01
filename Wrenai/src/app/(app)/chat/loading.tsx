import { Orbit } from "lucide-react";

export default function ChatLoading() {
  return (
    <div role="status" className="flex min-h-96 items-center justify-center gap-3 text-small text-fg-subtle">
      <Orbit size={20} aria-hidden="true" />
      Loading chat…
    </div>
  );
}
