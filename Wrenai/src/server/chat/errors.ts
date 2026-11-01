import type { ChatFailureCode } from "@/shared/chat";

export class ChatError extends Error {
  constructor(
    readonly code: ChatFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}
