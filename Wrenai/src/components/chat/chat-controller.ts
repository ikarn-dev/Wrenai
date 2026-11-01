import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ChatTurn, ConversationSummary } from "@/shared/chat";
import type { ResearchTool } from "@/shared/research";

export interface ChatController {
  readonly conversationId: string;
  readonly turns: readonly ChatTurn[];
  readonly history: readonly ConversationSummary[];
  readonly setHistory: Dispatch<SetStateAction<readonly ConversationSummary[]>>;
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  readonly tool: ResearchTool | null;
  readonly setTool: Dispatch<SetStateAction<ResearchTool | null>>;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly busy: boolean;
  readonly sending: boolean;
  readonly stopping: boolean;
  readonly checking: boolean;
  readonly loading: boolean;
  readonly hasEarlier: boolean;
  readonly preview: string;
  readonly status: string;
  readonly error: string | null;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly newChat: () => void;
  readonly select: (id: string) => void;
  readonly forget: (id: string) => void;
  readonly submit: () => void;
  readonly retry: (turn: ChatTurn) => void;
  readonly stop: () => Promise<void>;
  readonly check: () => Promise<void>;
  readonly earlier: () => Promise<void>;
}
