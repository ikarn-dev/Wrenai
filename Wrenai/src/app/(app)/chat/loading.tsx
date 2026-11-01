import { JarvisMark } from "@/components/chat/jarvis-mark";

export default function ChatLoading() {
  return (
    <div role="status" className="flex min-h-96 items-center justify-center gap-3 text-small text-fg-subtle">
      <JarvisMark size={20} className="motion-safe:animate-pulse" />
      Loading chat…
    </div>
  );
}
