import { describe, expect, it } from "vite-plus/test";
import { mergeWorkspaceSearch, validateFoundrySearch } from "./workspaceSearch";

describe("factory workspace links", () => {
  it("preserves existing run and handoff links together with workspace and evidence state", () => {
    const search = {
      view: "factories",
      factoryId: "factory",
      workItemId: "work",
      runId: "run",
      tab: "workflows",
      createWork: "1",
      workStatus: "active",
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

it("clears execution selection when leaving or changing runs but preserves same-run paging", () => {
  const previous = {
    runId: "first",
    nodeOffset: "100",
    nodePath: "old",
    attemptId: "a",
    attemptsAfter: "cursor",
    factoryId: "f",
  };
  for (const runId of ["second", undefined]) {
    expect(mergeWorkspaceSearch(previous, { runId })).toEqual({
      factoryId: "f",
      runId,
      nodeOffset: undefined,
      nodePath: undefined,
      attemptId: undefined,
      attemptsAfter: undefined,
    });
  }
  expect(mergeWorkspaceSearch(previous, { nodeOffset: "200" })).toEqual({
    ...previous,
    nodeOffset: "200",
  });
});
