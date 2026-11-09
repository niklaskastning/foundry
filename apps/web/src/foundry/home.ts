import { FoundryDescriptor } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { validateFoundrySearch } from "./workspaceSearch";

const decodeDescriptor = Schema.decodeUnknownSync(FoundryDescriptor);

export function factoryReturnPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/foundry(?:\?|$)/.test(value)) return "/";
  const url = new URL(value, "https://instance.invalid");
  const search = validateFoundrySearch(Object.fromEntries(url.searchParams));
  return `/foundry?${new URLSearchParams(Object.entries(search).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`;
}

export async function discoverFactoryHome(
  url: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Could not verify this instance. Reload to try again.");
  // Standalone T3 serves its HTML fallback for unknown discovery paths.
  if (response.headers.get("content-type")?.includes("text/html")) return false;
  return decodeDescriptor(await response.json()).automation?.protocolVersion === "1";
}

export function instanceReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/(?:foundry(?:\?|$)|chats(?:[/?]|$)|settings(?:[/?]|$)|threads(?:[/?]|$)|environments(?:[/?]|$))/.test(
      value,
    ) ||
    value.includes("\\")
  )
    return "/foundry?view=factories";
  return value;
}
