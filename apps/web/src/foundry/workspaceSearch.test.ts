import { describe, expect, it } from "vite-plus/test";
import { validateFoundrySearch } from "./workspaceSearch";

describe("factory workspace links", () => {
  it("preserves existing run and handoff links together with workspace and evidence state", () => {
    const search = {
      view: "factories",
      factoryId: "factory",
      workItemId: "work",
      runId: "run",
      tab: "agents",
      runState: "waiting",
      after: "cursor",
      attemptsAfter: "attempt-cursor",
      attemptId: "attempt",
      nodeOffset: "100",
      nodePath: "improve/iteration-2/review",
      inboxId: "decision",
      inboxStatus: "open",
      inboxKind: "approval",
      inboxUnread: "1",
      inboxCursor: "inbox-cursor",
      search: "Product",
      filterFactory: "factory",
      archiveEnvironmentId: "environment",
      archiveThreadId: "thread",
    };
    expect(validateFoundrySearch(search)).toEqual(search);
    expect(validateFoundrySearch({ view: "runs", factoryId: "factory", runId: "old-run" })).toEqual(
      { view: "runs", factoryId: "factory", runId: "old-run" },
    );
    expect(
      validateFoundrySearch({
        view: "factories",
        factoryId: "factory",
        workItemId: "handoff-work",
      }),
    ).toEqual({ view: "factories", factoryId: "factory", workItemId: "handoff-work" });
  });
  it("drops unsupported filters and malformed context instead of sending invalid queries", () => {
    expect(
      validateFoundrySearch({
        factoryId: ["factory"],
        workItemId: 1,
        runId: "",
        tab: "unknown",
        runState: "invalid",
        inboxStatus: "pending",
        inboxKind: "unknown",
        token: "secret",
        after: "x".repeat(1001),
      }),
    ).toEqual({});
  });
});
