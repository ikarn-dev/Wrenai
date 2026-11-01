export const SHORT_TITLE_WORDS = 4;
const SHORT_TITLE_CHARS = 36;

/**
 * The few leading words of a chat title, cut at a word boundary. Applied when a chat's first message becomes its
 * title and when titles are read, so chats saved before generated titles (or whose generation failed) stay short.
 */
export function shortChatTitle(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, SHORT_TITLE_WORDS);
  let title = "";
  for (const word of words) {
    const next = title === "" ? word : `${title} ${word}`;
    if (next.length > SHORT_TITLE_CHARS) {
      break;
    }
    title = next;
  }
  const fitted = title === "" ? (words[0] ?? "").slice(0, SHORT_TITLE_CHARS) : title;
  return fitted.replace(/[\s,.;:!?—–-]+$/, "") || "New chat";
}
