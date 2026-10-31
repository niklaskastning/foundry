export function isInstanceRequest(origin: string, address: string): boolean {
  try {
    const url = new URL(address);
    if (url.username || url.password) return false;
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.protocol === "https:" && url.origin === origin;
  } catch {
    return false;
  }
}

export function authorizeInstanceRequest(
  origin: string,
  address: string,
  headers: Record<string, string>,
  accessToken: string | undefined,
) {
  if (
    !accessToken ||
    !isInstanceRequest(origin, address) ||
    Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
  )
    return { cancel: true } as const;
  return { requestHeaders: { ...headers, Authorization: `Bearer ${accessToken}` } };
}
