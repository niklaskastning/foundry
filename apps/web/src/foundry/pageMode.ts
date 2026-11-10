import { initialState } from "./onboarding";

const workspaceViews = new Set(["factories", "work", "resources", "runs", "inbox"]);

export function isFoundrySignInPage(pathname: string, search: string): boolean {
  return (
    pathname === "/foundry" && !workspaceViews.has(new URLSearchParams(search).get("view") ?? "")
  );
}

export function hasConfirmedAutomationView(
  view: string | null | undefined,
  state: ReturnType<typeof initialState>,
): boolean {
  return (
    typeof view === "string" &&
    workspaceViews.has(view) &&
    state.confirmed &&
    state.binding !== null &&
    state.session !== null &&
    state.session.expiresAt > Date.now()
  );
}

export function isStandaloneFoundryPage(pathname: string, search: string): boolean {
  if (pathname !== "/foundry") return false;
  const params = new URLSearchParams(search);
  const view =
    params.has("archiveEnvironmentId") && params.has("archiveThreadId")
      ? "resources"
      : params.get("view");
  return !hasConfirmedAutomationView(view, initialState());
}
