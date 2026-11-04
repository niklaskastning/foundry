import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryDeviceId,
  ProjectId,
  type AutomationTriggerBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as GitHubApp from "./GitHubApp.ts";
import * as GitHubPolling from "./GitHubPolling.ts";
import * as Triggers from "./Triggers.ts";

it.effect("keeps issue identities across revisions, bindings, crash replay and rate limits", () =>
  Effect.gen(function* () {
    const now = 1_800_000_000_000;
    yield* TestClock.setTime(now);
    const binding: AutomationTriggerBinding = {
      id: "binding-a",
      factoryId: "factory",
      definitionVersionId: "definition",
      workflowVersionId: "workflow",
      repository: "repo",
      source: {
        kind: "github_issue",
        connectionId: "github-app",
        repositoryId: 123,
        repository: "owner/repo",
        label: "foundry:run",
      },
      target: {
        deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
        environmentId: EnvironmentId.make("worker"),
        projectId: ProjectId.make("explicit-project"),
        model: "fixture",
        checks: [],
        requiredArtifacts: [],
      },
      generation: 1,
      state: "active",
      activatedAt: now - 1000,
      nextDueAt: null,
      nextPollAt: now,
      reason: null,
      skippedRanges: 0,
    };
    let current = binding;
    let limited = false;
    let body = "Implement the change";
    let updatedAt = "2027-01-15T07:59:59.000Z";
    const batches: Array<Parameters<Triggers.Triggers["Service"]["acceptIssueBatch"]>[0]> = [];
    const failures: Array<Parameters<Triggers.Triggers["Service"]["pollFailed"]>[0]> = [];
    const store = Layer.mock(Triggers.Triggers)({
      duePolls: () =>
        Effect.succeed([
          {
            binding: current,
            cursor: { since: now - 60_000, page: 1, windowEnd: now },
            failures: 2,
          },
        ]),
      acceptIssueBatch: (batch) =>
        Effect.sync(() => {
          batches.push(batch);
          return true;
        }),
      pollFailed: (failure) =>
        Effect.sync(() => {
          failures.push(failure);
        }),
    });
    const github = Layer.mock(GitHubApp.GitHubApp)({
      listIssues: () => {
        if (limited)
          return Effect.fail(
            new GitHubApp.GitHubAppError({ reason: "rate_limited", retryAt: now + 500_000 }),
          );
        const issue = {
          id: 101,
          number: 1,
          title: "Test issue",
          body,
          state: "open",
          updatedAt,
          createdAt: "2027-01-15T07:59:00.000Z",
          user: { login: "human", type: "User" },
          labels: ["foundry:run"],
          isPullRequest: false,
        };
        return Effect.succeed({
          items: [
            issue,
            { ...issue, id: 102, isPullRequest: true },
            { ...issue, id: 103, user: { login: "foundry[bot]", type: "Bot" } },
            { ...issue, id: 104, labels: [] },
          ],
          nextPage: null,
        });
      },
    });
    const tick = Effect.gen(function* () {
      const service = yield* GitHubPolling.GitHubPolling;
      return yield* service.tick;
    }).pipe(
      Effect.provide(
        GitHubPolling.layer.pipe(
          Layer.provide(store),
          Layer.provide(github),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
    expect(yield* tick).toBe(1);
    expect(batches[0]?.issues).toHaveLength(1);
    expect(yield* tick).toBe(1);
    expect(batches[1]).toEqual(batches[0]);
    body = "Human edited scope";
    yield* tick;
    expect(batches[2]?.issues[0]?.id).toBe(batches[0]?.issues[0]?.id);
    expect(batches[2]?.issues[0]?.revision).not.toBe(batches[0]?.issues[0]?.revision);
    current = { ...binding, id: "binding-b" };
    yield* tick;
    expect(batches[3]?.issues[0]?.id).not.toBe(batches[0]?.issues[0]?.id);
    limited = true;
    expect(yield* tick).toBe(0);
    expect(batches).toHaveLength(4);
    expect(failures).toMatchObject([{ reason: "rate_limited", retryAt: now + 500_000 }]);
    expect(failures[0]?.expectedCursor).toEqual({ since: now - 60_000, page: 1, windowEnd: now });
    limited = false;
    updatedAt = "invalid-timestamp";
    expect(yield* tick).toBe(0);
    expect(failures.at(-1)?.reason).toBe("unavailable");
  }),
);
