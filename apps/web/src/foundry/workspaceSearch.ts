export const factoryTabs = [
  "overview",
  "work",
  "agents",
  "runs",
  "definition",
  "triggers",
] as const;
export const runStates = [
  "all",
  "pending",
  "running",
  "waiting",
  "paused",
  "cancel_requested",
  "cancelled",
  "failed",
  "succeeded",
] as const;
export type FoundrySearch = {
  view?: string | undefined;
  factoryId?: string | undefined;
  runId?: string | undefined;
  workItemId?: string | undefined;
  tab?: (typeof factoryTabs)[number] | undefined;
  runState?: (typeof runStates)[number] | undefined;
  filterFactory?: string | undefined;
  search?: string | undefined;
  after?: string | undefined;
  attemptsAfter?: string | undefined;
  attemptId?: string | undefined;
  inboxId?: string | undefined;
  inboxStatus?: "open" | "done" | "all" | undefined;
  inboxKind?: "question" | "answer" | "approval" | "blocker" | "error" | undefined;
  inboxUnread?: string | undefined;
  inboxCursor?: string | undefined;
  archiveEnvironmentId?: string | undefined;
  archiveThreadId?: string | undefined;
};
const fields = [
  "view",
  "factoryId",
  "runId",
  "workItemId",
  "filterFactory",
  "search",
  "after",
  "attemptsAfter",
  "attemptId",
  "inboxId",
  "inboxUnread",
  "inboxCursor",
  "archiveEnvironmentId",
  "archiveThreadId",
];
export function validateFoundrySearch(search: Record<string, unknown>): FoundrySearch {
  const strings = Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) =>
        fields.includes(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 1000,
    ),
  );
  return {
    ...strings,
    ...(factoryTabs.some((tab) => tab === search.tab)
      ? { tab: search.tab as FoundrySearch["tab"] }
      : {}),
    ...(runStates.some((state) => state === search.runState)
      ? { runState: search.runState as FoundrySearch["runState"] }
      : {}),
    ...(["open", "done", "all"].includes(String(search.inboxStatus))
      ? { inboxStatus: search.inboxStatus as FoundrySearch["inboxStatus"] }
      : {}),
    ...(["question", "answer", "approval", "blocker", "error"].includes(String(search.inboxKind))
      ? { inboxKind: search.inboxKind as FoundrySearch["inboxKind"] }
      : {}),
  };
}
