// Read at build time (the site is a static export, rendered by server components), so the value is baked into
// the HTML and no client code reads env vars. Public and non-secret: it's the app's address.
const DEV_APP_URL = "http://localhost:3000";

function readAppUrl(): URL {
  const configured = process.env["NEXT_PUBLIC_APP_URL"]?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_APP_URL is not set. Set it to the app's https address before building.");
    }
    return new URL(DEV_APP_URL);
  }
  const url = new URL(configured);
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
