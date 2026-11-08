import { expect, it } from "@effect/vitest";
import {
  FactoryDefinitionGitLocation,
  type FactoryDefinitionSourceBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as DefinitionSources from "./DefinitionSources.ts";
import * as DefinitionSync from "./DefinitionSync.ts";
import * as GitHubApp from "./GitHubApp.ts";

const binding: FactoryDefinitionSourceBinding = {
  connectionId: "github-app",
  repositoryId: 12,
  repository: "owner/test",
  branch: "main",
  path: "definitions",
  factoryId: "factory",
  scopeVersionId: "scope",
  instanceId: "instance",
  operatorId: "operator",
  appGeneration: 7,
  generation: 3,
  ownership: "pending",
  enabled: true,
  importVersionId: null,
  importContentHash: null,
  selectedRevisionId: null,
  status: "pending",
  error: null,
  nextSyncAt: 0,
};
const result = {
  commitSha: "a".repeat(40),
  files: [{ path: "factory.yaml", content: "invalid yaml" }],
};
const runTick = Effect.gen(function* () {
  const sync = yield* DefinitionSync.DefinitionSync;
  yield* sync.tick;
});

it.effect(
  "rejects revoked or mismatched App grants before fetching and continues other due sources",
  () =>
    Effect.gen(function* () {
      const rejected = [
        { ...binding, enabled: false },
        { ...binding, appGeneration: 6 },
        { ...binding, repositoryId: 99 },
        { ...binding, repository: "other/repo" },
      ];
      const failures: string[] = [];
      const accepted: string[] = [];
      const fetched: number[] = [];
      const sources = Layer.mock(DefinitionSources.DefinitionSources)({
        due: () =>
          Effect.succeed([...rejected, { ...binding, factoryId: "revoked-after-fetch" }, binding]),
        fail: (_saved, reason) =>
          Effect.sync(() => {
            failures.push(reason);
          }),
        accept: (saved) =>
          saved.factoryId === "revoked-after-fetch"
            ? Effect.fail(
                new DefinitionSources.DefinitionSourceError({
                  reason: "forbidden",
                  cause: new Error("private fixture details"),
                }),
              )
            : Effect.sync(() => {
                accepted.push(saved.factoryId);
              }),
      });
      const github = Layer.mock(GitHubApp.GitHubApp)({
        binding: () => Effect.succeed({ ...binding, generation: 7, baseBranch: "main" }),
        readDefinition: (input) =>
          Effect.sync(() => {
            fetched.push(input.generation);
            return result;
          }),
      });
      yield* runTick.pipe(
        Effect.provide(DefinitionSync.layer.pipe(Layer.provide(sources), Layer.provide(github))),
      );
      expect(failures).toEqual([...rejected, binding].map(() => "forbidden"));
      expect(fetched).toEqual([7, 7]);
      expect(accepted).toEqual(["factory"]);
    }),
);

it.effect(
  "persists bounded retries, reloads due work after restart and never activates a definition",
  () =>
    Effect.gen(function* () {
      let retryAt: number | undefined = 120_000;
      let recovered = false;
      let saved = binding;
      const failures: Array<{ reason: string; next: number }> = [];
      const accepted: Array<Parameters<DefinitionSources.DefinitionSources["Service"]["accept"]>> =
        [];
      const sources = Layer.mock(DefinitionSources.DefinitionSources)({
        due: (_now, limit) => {
          expect(limit).toBe(20);
          return Effect.succeed([saved]);
        },
        fail: (_saved, reason, next) =>
          Effect.sync(() => {
            failures.push({ reason, next });
          }),
        accept: (...args) =>
          Effect.sync(() => {
            accepted.push(args);
          }),
      });
      const github = Layer.mock(GitHubApp.GitHubApp)({
        binding: () => Effect.succeed({ ...binding, generation: 7, baseBranch: "main" }),
        readDefinition: () =>
          recovered
            ? Effect.succeed(result)
            : Effect.fail(
                new GitHubApp.GitHubAppError({
                  reason: "rate_limited",
                  ...(retryAt === undefined ? {} : { retryAt }),
                }),
              ),
      });
      const tick = runTick.pipe(
        Effect.provide(DefinitionSync.layer.pipe(Layer.provide(sources), Layer.provide(github))),
      );
      yield* tick;
      retryAt = Number.MAX_SAFE_INTEGER;
      yield* tick;
      retryAt = -1;
      yield* tick;
      retryAt = undefined;
      yield* tick;
      expect(failures).toEqual([
        { reason: "rate_limited", next: 120_000 },
        { reason: "rate_limited", next: 3_600_000 },
        { reason: "rate_limited", next: 60_000 },
        { reason: "rate_limited", next: 60_000 },
      ]);
      recovered = true;
      saved = { ...binding, generation: 4 };
      yield* tick;
      expect(accepted).toEqual([[saved, result, 0]]);
    }),
);

it.effect("reads an explicitly pinned commit instead of the moving branch", () =>
  Effect.gen(function* () {
    const pinned = { ...binding, commitSha: "b".repeat(40) };
    let reference: string | undefined;
    const sources = Layer.mock(DefinitionSources.DefinitionSources)({
      due: () => Effect.succeed([pinned]),
      accept: () => Effect.void,
    });
    const github = Layer.mock(GitHubApp.GitHubApp)({
      binding: () => Effect.succeed({ ...binding, generation: 7, baseBranch: "main" }),
      readDefinition: (input) =>
        Effect.sync(() => {
          reference = input.branch;
          return result;
        }),
    });
    yield* runTick.pipe(
      Effect.provide(DefinitionSync.layer.pipe(Layer.provide(sources), Layer.provide(github))),
    );
    expect(reference).toBe(pinned.commitSha);
  }),
);

it.effect("defaults source reads to main while validating explicit commit pins", () =>
  Effect.gen(function* () {
    const { branch: _branch, ...withoutBranch } = binding;
    const decode = Schema.decodeUnknownEffect(FactoryDefinitionGitLocation);
    expect((yield* decode(withoutBranch)).branch).toBe("main");
    expect(
      (yield* decode({ ...withoutBranch, commitSha: "not-a-sha" }).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }),
);
