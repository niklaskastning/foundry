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
  sessionCookieName?: string,
) {
  if (!accessToken || !isInstanceRequest(origin, address)) return { cancel: true } as const;
  const entries = Object.entries(headers);
  const authorization = entries.filter(([name]) => name.toLowerCase() === "authorization");
  if (entries.some(([name]) => name.toLowerCase() === "dpop")) return { cancel: true } as const;
  if (authorization.length === 0)
    return { requestHeaders: { ...headers, Authorization: `Bearer ${accessToken}` } };
  const token = authorization[0]?.[1].match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
  const cookies = entries.filter(([name]) => name.toLowerCase() === "cookie");
  if (
    authorization.length !== 1 ||
    !token ||
    !sessionCookieName ||
    !/^t3_session_[a-z0-9_]+$/.test(sessionCookieName) ||
    cookies.length > 1
  )
    return { cancel: true } as const;
  // T3 accepts its bearer via its scoped cookie; Access keeps Authorization. Never persist this adapter cookie.
  const cookie = (cookies[0]?.[1] ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.split("=", 1)[0]?.trim() !== sessionCookieName);
  cookie.push(`${sessionCookieName}=${token}`);
  return {
    requestHeaders: {
      ...Object.fromEntries(
        entries.filter(([name]) => !["authorization", "cookie"].includes(name.toLowerCase())),
      ),
      Cookie: cookie.join("; "),
      Authorization: `Bearer ${accessToken}`,
    },
  };
}
