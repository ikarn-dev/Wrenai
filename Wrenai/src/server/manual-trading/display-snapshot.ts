import "server-only";

/** Shares one public display read per worker. An unsuccessful read never becomes a fresh snapshot. */
export function displaySnapshot<T>(freshMs: number, read: () => Promise<T>): () => Promise<T> {
  let snapshot: { readonly data: T; readonly freshUntil: number } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (snapshot && snapshot.freshUntil > Date.now()) {
      return Promise.resolve(snapshot.data);
    }
    pending ??= read()
      .then((data) => {
        snapshot = { data, freshUntil: Date.now() + freshMs };
        return data;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
