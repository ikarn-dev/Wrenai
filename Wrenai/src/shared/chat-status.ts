// Status lines shown while Jarvis works, one set per stage, so the line says what is happening right now.
// A progress label is not evidence of a network connection or a completed verification.
const LINES = {
  connecting: ["Sending message…"],
  preparing: ["Preparing reply…"],
  thinking: ["Thinking…"],
  verifying: ["Verifying reply…"],
  research: ["Checking live data…"],
  writing: ["Writing reply…"],
  streaming: ["Writing · verification pending"],
  stopping: ["Stopping reply…"],
} as const;

export type ChatStatusStage = keyof typeof LINES;

/** One line for a stage, picked at random. Call once per stage, not per render, so the text doesn't flicker. */
export function chatStatus(stage: ChatStatusStage): string {
  const lines: readonly string[] = LINES[stage];
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0] ?? "";
}
