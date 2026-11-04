// @effect-diagnostics nodeBuiltinImport:off -- Main transfers verified Git objects without checking out or executing repository code.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { FoundryWorkerExecution, type FoundryPublishRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as DispatchStore from "./DispatchStore.ts";
import * as WorkerTransport from "./WorkerTransport.ts";
import * as GitHubApp from "./GitHubApp.ts";
import * as Artifacts from "../foundry/Artifacts.ts";

const executeFile = NodeUtil.promisify(NodeChildProcess.execFile);
const Binding = Schema.Struct({
  identity: WorkerTransport.WorkerIdentity,
  checks: Schema.Array(
    Schema.Struct({ id: Schema.String, command: Schema.String, cwd: Schema.String }),
  ),
});
const Result = Schema.Struct({ execution: FoundryWorkerExecution });
const isResult = Schema.is(Result);
const decodeResult = Schema.decodeUnknownOption(Result);
const decodeBinding = Schema.decodeUnknownEffect(Binding);
const decodeBytes = Schema.decodeEffect(Schema.Uint8ArrayFromBase64);
export class PublishError extends Schema.TaggedError<PublishError>()("PublishError", {
  reason: Schema.Literals([
    "credentials_required",
    "rate_limited",
    "evidence_required",
    "test_evidence_mismatch",
    "approval_revision_changed",
    "repository_denied",
    "grant_revoked",
    "publish_conflict",
    "unavailable",
  ]),
}) {}
const isPublishError = Schema.is(PublishError);
const isGitHubAppError = Schema.is(GitHubApp.GitHubAppError);
const isWorkerError = Schema.is(WorkerTransport.WorkerTransportError);
const failure = (cause: unknown) => {
  if (isPublishError(cause)) return cause;
  if (isGitHubAppError(cause))
    return new PublishError({
      reason:
        cause.reason === "credentials_required" || cause.reason === "rate_limited"
          ? cause.reason
          : cause.reason === "forbidden"
            ? "repository_denied"
            : cause.reason === "conflict"
              ? "publish_conflict"
              : "unavailable",
    });
  if (isWorkerError(cause) && cause.reason === "forbidden")
    return new PublishError({ reason: "grant_revoked" });
  return new PublishError({ reason: "unavailable" });
};
export interface PublishOutcome {
  readonly state: "waiting" | "published";
  readonly reason: string | null;
  readonly operationKey: string;
  readonly result: GitHubApp.PublishedPullRequest | null;
}
export class Publish extends Context.Service<
  Publish,
  {
    readonly prepareEvidence: (
      claim: DispatchStore.DispatchClaim,
    ) => Effect.Effect<typeof FoundryPublishRequest.Type | null, PublishError>;
    readonly execute: (
      claim: DispatchStore.DispatchClaim,
      stepId: string,
    ) => Effect.Effect<PublishOutcome, PublishError>;
  }
>()("t3/automation/Publish") {}

const validateEvidence = (
  claim: DispatchStore.DispatchRun,
  stepId: string,
  checks: ReadonlyArray<{ id: string; command: string; cwd: string }>,
) => {
  const index = claim.workflow.steps.findIndex(
    (step) => step.id === stepId && step.kind === "publish",
  );
  const attempts = [
    ...new Map(claim.attempts.map((attempt) => [attempt.ordinal, attempt])).values(),
  ];
  if (
    index < 1 ||
    attempts.filter((attempt) => attempt.ordinal < index).length !== index ||
    attempts.some((attempt) => attempt.ordinal < index && attempt.state !== "succeeded")
  )
    return null;
  const required = claim.workflow.steps.slice(0, index).filter((step) => step.kind === "test");
  if (required.length === 0) return null;
  const last = attempts.findLast((attempt) => attempt.ordinal < index && isResult(attempt.result));
  const result = last ? decodeResult(last.result) : null;
  if (!result || result._tag === "None") return null;
  const execution = result.value.execution;
  const evidence = execution.lifecycle?.manifest?.publishEvidence;
  if (
    !evidence ||
    !execution.lifecycle?.writerEnded ||
    execution.lifecycle.manifest?.outcome !== "completed"
  )
    return null;
  if (
    evidence.checks.length !== required.length ||
    required.some((step) => {
      const configured = checks.find((check) => check.id === step.checkId);
      const confirmed = evidence.checks.find((check) => check.id === step.checkId);
      return (
        !configured ||
        !confirmed ||
        confirmed.command !== configured.command ||
        confirmed.cwd !== configured.cwd ||
        confirmed.commitSha !== evidence.commitSha ||
        confirmed.treeSha !== evidence.treeSha ||
        confirmed.exitCode !== 0
      );
    })
  )
    return null;
  if (evidence.bundle.reference.owner.threadId !== execution.receipt.threadId) return null;
  return evidence;
};

interface TransferInput {
  readonly bytes: Uint8Array;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly repository: string;
  readonly branch: string;
  readonly credential: Effect.Effect<Redacted.Redacted<string>, PublishError>;
  readonly authorize: Effect.Effect<void, PublishError>;
}
const transferBundle = Effect.fn("Publish.transferBundle")(function* (input: TransferInput) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "foundry-transfer-")),
          catch: failure,
        }),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const file = NodePath.join(directory, "result.bundle");
      yield* Effect.tryPromise({
        try: () => NodeFSP.writeFile(file, input.bytes, { mode: 0o600 }),
        catch: failure,
      });
      const git = Effect.fn("Publish.git")(
        (args: ReadonlyArray<string>, token?: Redacted.Redacted<string>) =>
          Effect.tryPromise({
            try: async () =>
              (
                await executeFile("git", ["-c", "core.hooksPath=/dev/null", ...args], {
                  cwd: directory,
                  maxBuffer: 1024 * 1024,
                  timeout: 30000,
                  env: {
                    PATH: process.env.PATH,
                    HOME: directory,
                    GIT_CONFIG_NOSYSTEM: "1",
                    GIT_CONFIG_GLOBAL: "/dev/null",
                    GIT_TERMINAL_PROMPT: "0",
                    ...(token
                      ? {
                          GIT_CONFIG_COUNT: "1",
                          GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
                          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64")}`,
                        }
                      : {}),
                  },
                })
              ).stdout.trim(),
            catch: failure,
          }),
      );
      yield* git(["init", "--bare", "repository"]);
      yield* git(["--git-dir=repository", "fetch", "--", file, "HEAD:refs/heads/verified"]);
      const sha = yield* git(["--git-dir=repository", "rev-parse", "refs/heads/verified"]);
      const tree = yield* git(["--git-dir=repository", "rev-parse", "refs/heads/verified^{tree}"]);
      if (sha !== input.commitSha || tree !== input.treeSha)
        return yield* new PublishError({ reason: "evidence_required" });
      yield* input.authorize;
      const token = yield* input.credential;
      const remote = `https://github.com/${input.repository}.git`;
      const existing = yield* git(
        ["ls-remote", "--heads", remote, `refs/heads/${input.branch}`],
        token,
      );
      if (existing && existing.split(/\s+/)[0] !== sha)
        return yield* new PublishError({ reason: "publish_conflict" });
      if (!existing) {
        yield* input.authorize;
        yield* git(
          [
            "--git-dir=repository",
            "push",
            "--porcelain",
            remote,
            `${sha}:refs/heads/${input.branch}`,
          ],
          token,
        );
      }
    }),
  );
});
export const GitTransfer = Context.Reference<
  (input: TransferInput) => Effect.Effect<void, PublishError>
>("t3/automation/GitTransfer", { defaultValue: () => transferBundle });

export class PublishOperations extends Context.Service<
  PublishOperations,
  {
    readonly begin: (input: {
      operationKey: string;
      runId: string;
      stepId: string;
      commitSha: string;
      resultRevision: number;
      repository: string;
      request: unknown;
    }) => Effect.Effect<GitHubApp.PublishedPullRequest | null, PublishError>;
    readonly finish: (
      operationKey: string,
      request: unknown,
      result: GitHubApp.PublishedPullRequest,
    ) => Effect.Effect<void, PublishError>;
  }
>()("t3/automation/Publish/PublishOperations") {}
export const operationsLayer = Layer.effect(
  PublishOperations,
  Effect.gen(function* () {
    const sql = yield* AutomationDatabase.AutomationDatabase;
    return PublishOperations.of({
      begin: Effect.fn("PublishOperations.begin")(function* (input) {
        const rows = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO foundry_automation.publish_operations(operation_key,run_id,step_id,commit_sha,result_revision,repository,request) VALUES(${input.operationKey},${input.runId},${input.stepId},${input.commitSha},${input.resultRevision},${input.repository},${sql.json(input.request)}) ON CONFLICT DO NOTHING`;
            return yield* sql<{
              same: boolean;
              result: GitHubApp.PublishedPullRequest | null;
            }>`SELECT request=${sql.json(input.request)}::jsonb AS same,result FROM foundry_automation.publish_operations WHERE operation_key=${input.operationKey}`;
          }),
        );
        if (!rows[0]?.same) return yield* new PublishError({ reason: "publish_conflict" });
        return rows[0].result;
      }, Effect.mapError(failure)),
      finish: Effect.fn("PublishOperations.finish")(function* (operationKey, request, result) {
        const rows =
          yield* sql`UPDATE foundry_automation.publish_operations SET state='published',result=${sql.json(result)} WHERE operation_key=${operationKey} AND request=${sql.json(request)}::jsonb AND (result IS NULL OR result=${sql.json(result)}::jsonb) RETURNING operation_key`;
        if (rows.length !== 1) return yield* new PublishError({ reason: "publish_conflict" });
      }, Effect.mapError(failure)),
    });
  }),
);
export const serviceLayer = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const operations = yield* PublishOperations;
    const transfer = yield* GitTransfer;
    const store = yield* DispatchStore.DispatchStore;
    const worker = yield* WorkerTransport.WorkerTransport;
    const github = yield* GitHubApp.GitHubApp;
    const artifacts = yield* Artifacts.Artifacts;
    const prepareEvidence = Effect.fn("Publish.prepareEvidence")(function* (
      claim: DispatchStore.DispatchClaim,
    ) {
      if (!claim.workflow.steps.some((step) => step.kind === "publish")) return null;
      const configured = yield* decodeBinding(claim.binding);
      const binding = yield* github.binding(claim.run.repository);
      const ids = claim.workflow.steps
        .filter((step) => step.kind === "test")
        .map((step) => step.checkId);
      const checks = ids.map((id) => configured.checks.find((check) => check.id === id));
      if (!ids.length || checks.some((check) => !check))
        return yield* new PublishError({ reason: "evidence_required" });
      return {
        repository: binding.repository,
        baseBranch: binding.baseBranch,
        checks: checks.flatMap((check) => (check ? [check] : [])),
      };
    }, Effect.mapError(failure));
    const execute = Effect.fn("Publish.execute")(function* (
      claim: DispatchStore.DispatchClaim,
      stepId: string,
    ) {
      const operationKey = `publish:${NodeCrypto.createHash("sha256").update(`${claim.run.id}:${stepId}:${claim.resultRevision}`).digest("hex")}`;
      const configured = yield* decodeBinding(claim.binding);
      const current = yield* store.read(claim.run.factoryId, claim.run.id);
      if (claim.resultRevision !== current.resultRevision)
        return yield* new PublishError({ reason: "approval_revision_changed" });
      const evidence = validateEvidence(current, stepId, configured.checks);
      if (!evidence)
        return {
          state: "waiting" as const,
          reason: "test_evidence_mismatch",
          operationKey,
          result: null,
        };
      const binding = yield* github.binding(claim.run.repository);
      if (binding.repository !== evidence.repository || binding.baseBranch !== evidence.baseBranch)
        return yield* new PublishError({ reason: "repository_denied" });
      const authorize = Effect.fn("Publish.authorize")(function* () {
        const fresh = yield* store.read(claim.run.factoryId, claim.run.id);
        if (
          fresh.resultRevision !== current.resultRevision ||
          !(yield* store.canLaunch(claim)) ||
          !(yield* store.approved(claim, stepId))
        )
          return yield* new PublishError({ reason: "approval_revision_changed" });
        const app = yield* github.binding(claim.run.repository);
        if (
          app.generation !== binding.generation ||
          app.repositoryId !== binding.repositoryId ||
          app.repository !== binding.repository ||
          app.baseBranch !== binding.baseBranch
        )
          return yield* new PublishError({ reason: "grant_revoked" });
        yield* worker.status(configured.identity);
      });
      yield* authorize();
      const request = { binding, evidence, stepId, resultRevision: current.resultRevision };
      const saved = yield* operations.begin({
        operationKey,
        runId: claim.run.id,
        stepId,
        commitSha: evidence.commitSha,
        resultRevision: current.resultRevision ?? 0,
        repository: binding.repository,
        request,
      });
      if (saved) return { state: "published" as const, reason: null, operationKey, result: saved };
      const stored = yield* artifacts.status(configured.identity, evidence.bundle.reference);
      if (
        stored.state !== "published" ||
        stored.sha256 !== evidence.bundle.sha256 ||
        stored.sizeBytes !== evidence.bundle.sizeBytes
      )
        return yield* new PublishError({ reason: "evidence_required" });
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (offset < stored.sizeBytes) {
        const chunk = yield* artifacts.read(configured.identity, {
          reference: evidence.bundle.reference,
          offset,
        });
        const bytes = yield* decodeBytes(chunk.data);
        if (chunk.offset !== offset || chunk.fileSha256 !== stored.sha256 || bytes.length === 0)
          return yield* new PublishError({ reason: "evidence_required" });
        parts.push(bytes);
        offset += bytes.length;
      }
      const bytes = Buffer.concat(parts);
      if (
        bytes.length !== stored.sizeBytes ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== stored.sha256
      )
        return yield* new PublishError({ reason: "evidence_required" });
      const branch = `foundry/${NodeCrypto.createHash("sha256").update(operationKey).digest("hex")}`;
      yield* transfer({
        bytes,
        commitSha: evidence.commitSha,
        treeSha: evidence.treeSha,
        repository: binding.repository,
        branch,
        credential: github.credential({ ...binding, write: true }).pipe(Effect.mapError(failure)),
        authorize: authorize().pipe(Effect.mapError(failure)),
      });
      yield* authorize();
      const result = yield* github.publish({
        ...binding,
        commitSha: evidence.commitSha,
        branch,
        baseBranch: evidence.baseBranch,
        operationKey,
        title: `Foundry: ${claim.run.workItemId}`,
        authorize: authorize().pipe(
          Effect.mapError(() => new GitHubApp.GitHubAppError({ reason: "forbidden" })),
        ),
      });
      yield* operations.finish(operationKey, request, result);
      return { state: "published" as const, reason: null, operationKey, result };
    }, Effect.mapError(failure));
    return Publish.of({ prepareEvidence, execute });
  }),
);

export const layer = serviceLayer.pipe(Layer.provide(operationsLayer));
