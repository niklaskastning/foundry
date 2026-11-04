import { initialState } from "./onboarding";

export function hasConfirmedAutomationView(
  view: string | null | undefined,
  state: ReturnType<typeof initialState>,
): boolean {
  return (
    (view === "factories" || view === "runs" || view === "inbox") &&
    state.confirmed &&
    state.binding !== null
  );
}

export function isStandaloneFoundryPage(pathname: string, search: string): boolean {
  if (pathname !== "/foundry") return false;
  const view = new URLSearchParams(search).get("view");
  return !hasConfirmedAutomationView(view, initialState());
}
