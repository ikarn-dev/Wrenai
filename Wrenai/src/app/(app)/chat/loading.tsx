import { JarvisLoading } from "@/components/chat/jarvis-mark";

export default function ChatLoading() {
  return (
    <div className="flex min-h-96 items-center justify-center">
      <JarvisLoading label="Loading chat" />
    </div>
  );
}
