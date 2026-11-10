import { searchRecords } from "@/docs/source";

// Written once at build time to /search-index.json (a static export renders force-static route handlers to
// files). The search dialog fetches it on first open and searches it in the browser.
export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(searchRecords());
}
