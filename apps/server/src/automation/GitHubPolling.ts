import { AutomationTriggerError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as GitHubApp from "./GitHubApp.ts";
import * as Triggers from "./Triggers.ts";

export class GitHubPolling extends Context.Service<
  GitHubPolling,
  {
    readonly tick: Effect.Effect<number, AutomationTriggerError>;
  }
>()("t3/automation/GitHubPolling") {}
const isGitHubError = Schema.is(GitHubApp.GitHubAppError);
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
);
const make = Effect.gen(function* () {
  const triggers = yield* Triggers.Triggers;
  const github = yield* GitHubApp.GitHubApp;
  const crypto = yield* Crypto.Crypto;
  const digest = Effect.fn("GitHubPolling.digest")((parts: ReadonlyArray<string | number>) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(encodeKey(parts)))
      .pipe(Effect.map(Hex.encode)),
  );
  const poll = Effect.fn("GitHubPolling.poll")(function* (
    saved: Triggers.PollBinding,
    now: number,
  ) {
    const binding = saved.binding;
    if (binding.source.kind !== "github_issue") return false;
    const source = binding.source;
    const windowEnd = saved.cursor.page === 1 ? now : saved.cursor.windowEnd;
    const page = yield* github.listIssues({
      connectionId: source.connectionId,
      repositoryId: source.repositoryId,
      repository: source.repository,
      since: DateTime.formatIso(DateTime.makeUnsafe(saved.cursor.since)),
      page: saved.cursor.page,
      perPage: 100,
    });
    const issues: Triggers.IncomingIssue[] = [];
    for (const issue of page.items) {
      if (
        issue.isPullRequest ||
        issue.state !== "open" ||
        issue.user.type === "Bot" ||
        !issue.labels.includes(source.label)
      )
        continue;
      const occurredAt = yield* Effect.try({
        try: () => DateTime.toEpochMillis(DateTime.makeUnsafe(issue.updatedAt)),
        catch: () => new GitHubApp.GitHubAppError({ reason: "unavailable" }),
      });
      if (!Number.isFinite(occurredAt) || occurredAt > windowEnd) continue;
      const externalId = `${source.connectionId}:${source.repositoryId}:${issue.id}`;
      const id = `github:${yield* digest([binding.id, binding.generation, externalId])}`;
      const revision = yield* digest([issue.id, issue.title, issue.body ?? ""]);
      issues.push({
        id,
        externalId,
        revision,
        title: issue.title.slice(0, 500),
        occurredAt,
        payload: {
          repository: source.repository,
          issueNumber: issue.number,
          actor: issue.user.login,
          title: issue.title.slice(0, 500),
          body: (issue.body ?? "").slice(0, 50_000),
          reference: `https://github.com/${source.repository}/issues/${issue.number}`,
        },
      });
    }
    return yield* triggers.acceptIssueBatch({
      bindingId: binding.id,
      generation: binding.generation,
      expectedCursor: saved.cursor,
      issues,
      nextCursor:
        page.nextPage === null
          ? { since: Math.max(0, windowEnd - 60_000), page: 1, windowEnd }
          : { since: saved.cursor.since, page: page.nextPage, windowEnd },
      complete: page.nextPage === null,
    });
  });
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const bindings = yield* triggers.duePolls(now, 20);
    let count = 0;
    for (const binding of bindings) {
      const accepted = yield* poll(binding, now).pipe(
        Effect.catch((cause) => {
          const error = isGitHubError(cause) ? cause : null;
          const retryAt = Math.max(
            now + Math.min(3_600_000, 60_000 * 2 ** Math.min(binding.failures, 6)),
            error?.retryAt ?? 0,
          );
          return triggers
            .pollFailed({
              bindingId: binding.binding.id,
              generation: binding.binding.generation,
              expectedCursor: binding.cursor,
              reason: error?.reason ?? "unavailable",
              retryAt,
            })
            .pipe(Effect.as(false));
        }),
      );
      if (accepted) count++;
    }
    return count;
  }).pipe(Effect.withSpan("GitHubPolling.tick"));
  return GitHubPolling.of({ tick });
});
export const layer = Layer.effect(GitHubPolling, make);
