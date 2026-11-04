// The app's address. Read at build time (the site is a static export, rendered by server components), so the
// value is baked into the HTML and no client code reads env vars. NEXT_PUBLIC_APP_URL can point the links
// elsewhere, such as the app's local dev server; it's public and non-secret.
const PRODUCTION_APP_URL = "https://app.wrenai.xyz";

function readAppUrl(): URL {
  const configured = process.env["NEXT_PUBLIC_APP_URL"]?.trim();
  const url = new URL(configured || PRODUCTION_APP_URL);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_APP_URL must be an https address for production builds.");
  }
  return url;
}

const APP_URL = readAppUrl();

/** An absolute link into the Wrenai app. */
export function appHref(path: `/${string}`): string {
  return new URL(path, APP_URL).toString();
}
