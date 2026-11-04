// The hero's tool chips: four of the app's active research tools (Docs/DESIGN.md, November 2 scope). The IDs are
// the app's tool IDs; /chat?tool=… opens Jarvis scoped to that tool.
export const TOOLS = [
  { id: "spot_trader", label: "Spot Trader" },
  { id: "dca", label: "DCA" },
  { id: "perps", label: "Perps" },
  { id: "meme_hunter", label: "Meme Hunter" },
] as const;

export type ToolId = (typeof TOOLS)[number]["id"];

// Example questions typed into the box, each with the tool it belongs to. Questions only: nothing claims a result.
export const EXAMPLES: readonly { readonly text: string; readonly tool: ToolId }[] = [
  { text: "Is now a good time to DCA into NEAR?", tool: "dca" },
  { text: "Buy NEAR if it dips 8% from here", tool: "spot_trader" },
  { text: "What's the funding rate on NEAR perps today?", tool: "perps" },
  { text: "Find meme tokens on NEAR with rising volume", tool: "meme_hunter" },
  { text: "Set up a weekly $50 buy of NEAR", tool: "dca" },
  { text: "Sell half my NEAR if it rallies 15%", tool: "spot_trader" },
  { text: "Should I go long or short NEAR today?", tool: "perps" },
];
