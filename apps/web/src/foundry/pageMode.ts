import { initialState } from "./onboarding";

export function isStandaloneFoundryPage(pathname: string, search: string): boolean {
  if (pathname !== "/foundry") return false;
  const view = new URLSearchParams(search).get("view");
  if (view !== "factories" && view !== "runs" && view !== "inbox") return true;
  const state = initialState();
  return !state.confirmed || state.binding === null;
}
