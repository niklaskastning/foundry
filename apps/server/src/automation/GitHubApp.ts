// @effect-diagnostics nodeBuiltinImport:off -- GitHub installation authentication requires an RSA-signed JWT.
import { FactoryDefinitionFiles, FactoryDefinitionGitLocation } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import { sendAuthenticated } from "@t3tools/source-control-github/server/GitHubHttp";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class GitHubAppError extends Schema.TaggedError<GitHubAppError>()("GitHubAppError", {
  reason: Schema.Literals([
    "forbidden",
    "credentials_required",
    "rate_limited",
    "unavailable",
    "conflict",
  ]),
  retryAt: Schema.optional(Schema.Number),
}) {}
const isGitHubAppError = Schema.is(GitHubAppError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Repository = Schema.Struct({
  id: Schema.Int,
  fullName: Schema.String,
  bindingKey: Schema.String,
  baseBranch: Schema.String,
  purpose: Schema.optional(Schema.Literals(["automation", "definitions"])),
});
const Configuration = Schema.Struct({
  appId: Schema.String,
  installationId: Schema.Int,
  privateKey: Schema.String,
  generation: Schema.Int,
  repositories: Schema.Array(Repository),
});
const Token = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
  repositories: Schema.Array(Schema.Struct({ id: Schema.Int, full_name: Schema.String })),
});
const Issue = Schema.Struct({
  id: Schema.Int,
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  updated_at: Schema.String,
  created_at: Schema.String,
  user: Schema.Struct({ login: Schema.String, type: Schema.String }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  pull_request: Schema.optional(Schema.Unknown),
});
const PullRequest = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
});
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Commit = Schema.Struct({ sha: Sha });
const Tree = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Sha,
      size: Schema.optional(Schema.Int),
    }),
  ).check(Schema.isMaxLength(4096)),
});
const Contents = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  sha: Sha,
  size: Schema.Int,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
});
const safePath = (path: string) =>
  path.length <= 200 &&
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
  path.split("/").every((part) => part !== "." && part !== "..");
const decodeDefinitionLocation = Schema.decodeUnknownEffect(FactoryDefinitionGitLocation);
const decodeDefinitionFiles = Schema.decodeEffect(FactoryDefinitionFiles);
const decodeCommit = Schema.decodeUnknownEffect(Commit);
const decodeTree = Schema.decodeUnknownEffect(Tree);
const decodeContents = Schema.decodeUnknownEffect(Contents);
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeToken = Schema.decodeUnknownEffect(Token);
const decodeIssues = Schema.decodeUnknownEffect(Schema.Array(Issue));
const decodePullRequests = Schema.decodeUnknownEffect(Schema.Array(PullRequest));
export interface GitHubRepositoryBinding {
  readonly connectionId: string;
  readonly repositoryId: number;
  readonly repository: string;
}
export interface PublishedPullRequest {
  readonly number: number;
  readonly url: string;
  readonly commitSha: string;
  readonly operationKey: string;
}
export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    readonly readDefinition: (
      input: GitHubRepositoryBinding & { generation: number; branch: string; path: string },
    ) => Effect.Effect<{ commitSha: string; files: FactoryDefinitionFiles }, GitHubAppError>;
    readonly listIssues: (
      input: GitHubRepositoryBinding & { since: string; page: number; perPage: number },
    ) => Effect.Effect<
      {
        items: ReadonlyArray<{
          id: number;
          number: number;
          title: string;
          body: string | null;
          state: string;
          updatedAt: string;
          createdAt: string;
          user: { login: string; type: string };
          labels: ReadonlyArray<string>;
          isPullRequest: boolean;
        }>;
        nextPage: number | null;
      },
      GitHubAppError
    >;
    readonly binding: (
      repository: string,
    ) => Effect.Effect<
      GitHubRepositoryBinding & { generation: number; baseBranch: string },
      GitHubAppError
    >;
    readonly credential: (
      input: GitHubRepositoryBinding & { generation: number; write: boolean },
    ) => Effect.Effect<Redacted.Redacted<string>, GitHubAppError>;
    readonly publish: (
      input: GitHubRepositoryBinding & {
        generation: number;
        commitSha: string;
        branch: string;
        baseBranch: string;
        operationKey: string;
        title: string;
        authorize: Effect.Effect<void, GitHubAppError>;
      },
    ) => Effect.Effect<PublishedPullRequest, GitHubAppError>;
  }
>()("t3/automation/GitHubApp") {}
const unavailable = () => new GitHubAppError({ reason: "unavailable" });
const denied = () => new GitHubAppError({ reason: "forbidden" });
const conflict = () => new GitHubAppError({ reason: "conflict" });
export const layer = Layer.effect(
  GitHubApp,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const http = yield* HttpClient.HttpClient;
    const configuration = Effect.fn("GitHubApp.configuration")(
      function* () {
        const bytes = yield* secrets.get("foundry-github-app");
        if (Option.isNone(bytes))
          return yield* new GitHubAppError({ reason: "credentials_required" });
        return yield* decodeConfiguration(new TextDecoder().decode(bytes.value));
      },
      Effect.mapError((error) => (isGitHubAppError(error) ? error : unavailable())),
    );
    const binding = Effect.fn("GitHubApp.binding")(function* (repository: string) {
      const config = yield* configuration();
      const found = config.repositories.find(
        (item) => item.fullName === repository || item.bindingKey === repository,
      );
      if (!found || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(found.fullName))
        return yield* denied();
      return {
        connectionId: "github-app",
        repositoryId: found.id,
        repository: found.fullName,
        generation: config.generation,
        baseBranch: found.baseBranch,
      };
    });
    const request = Effect.fn("GitHubApp.request")(
      function* (token: Redacted.Redacted<string>, path: string, body?: unknown) {
        let req = HttpClientRequest.make(body === undefined ? "GET" : "POST")(
          `https://api.github.com/${path}`,
          {
            headers: {
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": "foundry-automation",
            },
          },
        );
        if (body !== undefined) req = yield* HttpClientRequest.bodyJson(req, body);
        const response = yield* sendAuthenticated(http, {
          request: req,
          authorization: Redacted.make(`Bearer ${Redacted.value(token)}`),
          maxResponseBytes: 2 * 1024 * 1024,
        }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
        );
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers["retry-after"] || response.headers["x-ratelimit-remaining"] === "0"))
        ) {
          const now = yield* Clock.currentTimeMillis;
          const delay = Number(response.headers["retry-after"] ?? "60") * 1000;
          const reset = Number(response.headers["x-ratelimit-reset"] ?? "0") * 1000;
          return yield* new GitHubAppError({
            reason: "rate_limited",
            retryAt:
              now +
              Math.min(
                3600000,
                Math.max(
                  1000,
                  Number.isFinite(delay) ? delay : 60000,
                  Number.isFinite(reset) ? reset - now : 0,
                ),
              ),
          });
        }
        if (response.status === 401 || response.status === 403 || response.status === 404)
          return yield* denied();
        if (response.status === 422) return yield* conflict();
        if (response.status < 200 || response.status >= 300) return yield* unavailable();
        if (response.truncated || response.invalidUtf8) return yield* unavailable();
        return yield* decodeJson(response.body);
      },
      Effect.timeout("20 seconds"),
      Effect.mapError((error) => (isGitHubAppError(error) ? error : unavailable())),
    );
    const installationToken = Effect.fn("GitHubApp.installationToken")(function* (
      input: GitHubRepositoryBinding & { generation: number },
      permissions:
        | { contents: "read" }
        | { issues: "read" }
        | { contents: "write"; pull_requests: "write" },
    ) {
      const config = yield* configuration();
      const current = yield* binding(input.repository);
      if (
        input.connectionId !== current.connectionId ||
        input.repositoryId !== current.repositoryId ||
        input.generation !== current.generation
      )
        return yield* denied();
      const repository = config.repositories.find(
        (item) => item.id === input.repositoryId && item.fullName === input.repository,
      );
      if (
        config.generation !== input.generation ||
        !repository ||
        (repository.purpose === "definitions" &&
          !("contents" in permissions && permissions.contents === "read"))
      )
        return yield* denied();
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const jwt = yield* Effect.try({
        try: () => {
          const header = Buffer.from(encodeJson({ alg: "RS256", typ: "JWT" })).toString(
            "base64url",
          );
          const payload = Buffer.from(
            encodeJson({ iat: now - 60, exp: now + 300, iss: config.appId }),
          ).toString("base64url");
          const content = `${header}.${payload}`;
          return Redacted.make(
            `${content}.${NodeCrypto.createSign("RSA-SHA256").update(content).sign(config.privateKey, "base64url")}`,
          );
        },
        catch: unavailable,
      });
      const result = yield* request(
        jwt,
        `app/installations/${config.installationId}/access_tokens`,
        {
          repository_ids: [input.repositoryId],
          permissions,
        },
      );
      const token = yield* decodeToken(result).pipe(Effect.mapError(unavailable));
      if (
        token.repositories.length !== 1 ||
        token.repositories[0]?.id !== input.repositoryId ||
        token.repositories[0]?.full_name !== input.repository ||
        !Number.isFinite(Date.parse(token.expires_at)) ||
        Date.parse(token.expires_at) <= now * 1000
      )
        return yield* denied();
      return Redacted.make(token.token);
    });
    const credential = Effect.fn("GitHubApp.credential")(
      (input: GitHubRepositoryBinding & { generation: number; write: boolean }) =>
        installationToken(
          input,
          input.write ? { contents: "write", pull_requests: "write" } : { issues: "read" },
        ),
    );
    const checkGrant = Effect.fn("GitHubApp.checkDefinitionGrant")(function* (
      input: GitHubRepositoryBinding & { generation: number },
    ) {
      const current = yield* binding(input.repository);
      if (
        current.connectionId !== input.connectionId ||
        current.repositoryId !== input.repositoryId ||
        current.repository !== input.repository ||
        current.generation !== input.generation
      )
        return yield* denied();
    });
    const readDefinition = Effect.fn("GitHubApp.readDefinition")(
      function* (
        input: GitHubRepositoryBinding & { generation: number; branch: string; path: string },
      ) {
        yield* decodeDefinitionLocation(input);
        yield* checkGrant(input);
        const token = yield* installationToken(input, { contents: "read" });
        const get = Effect.fn("GitHubApp.readDefinitionRequest")(function* (path: string) {
          yield* checkGrant(input);
          const result = yield* request(token, path);
          yield* checkGrant(input);
          return result;
        });
        const base = `repos/${input.repository}`;
        const commit = yield* get(`${base}/commits/${encodeURIComponent(input.branch)}`).pipe(
          Effect.flatMap(decodeCommit),
        );
        const tree = yield* get(`${base}/git/trees/${commit.sha}?recursive=1`).pipe(
          Effect.flatMap(decodeTree),
        );
        if (tree.truncated) return yield* unavailable();
        const prefix = input.path ? `${input.path}/` : "";
        if (
          input.path &&
          !tree.tree.some(
            (entry) =>
              entry.path === input.path && entry.type === "tree" && entry.mode === "040000",
          )
        )
          return yield* unavailable();
        const entries = tree.tree.filter((entry) => entry.path.startsWith(prefix));
        const paths = new Set<string>();
        const selected: typeof entries = [];
        let total = 0;
        for (const entry of entries) {
          const path = entry.path.slice(prefix.length);
          if (!safePath(path) || paths.has(path)) return yield* unavailable();
          paths.add(path);
          if (entry.type === "tree" && entry.mode === "040000") continue;
          if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
            return yield* unavailable();
          if (!/\.ya?ml$/.test(path)) continue;
          if (entry.size === undefined || entry.size < 0 || entry.size > 256 * 1024)
            return yield* unavailable();
          total += entry.size;
          selected.push(entry);
        }
        if (
          selected.length > 101 ||
          total > 2 * 1024 * 1024 ||
          !selected.some((entry) => entry.path === `${prefix}factory.yaml`)
        )
          return yield* unavailable();
        const files: Array<{ path: string; content: string }> = [];
        for (const entry of selected.sort((a, b) => a.path.localeCompare(b.path))) {
          const file = yield* get(
            `${base}/contents/${entry.path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`,
          ).pipe(Effect.flatMap(decodeContents));
          if (file.path !== entry.path || file.sha !== entry.sha || file.size !== entry.size)
            return yield* unavailable();
          const content = yield* Effect.try({
            try: () => {
              const encoded = file.content.replace(/\n/g, "");
              const bytes = Buffer.from(encoded, "base64");
              if (
                bytes.toString("base64") !== encoded ||
                bytes.length !== file.size ||
                NodeCrypto.createHash("sha1")
                  .update(`blob ${bytes.length}\0`)
                  .update(bytes)
                  .digest("hex") !== entry.sha
              )
                throw new Error("Invalid Git blob");
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            },
            catch: unavailable,
          });
          files.push({ path: entry.path.slice(prefix.length), content });
        }
        yield* checkGrant(input);
        return {
          commitSha: commit.sha,
          files: yield* decodeDefinitionFiles(files),
        };
      },
      Effect.mapError((error) => (isGitHubAppError(error) ? error : unavailable())),
    );
    const listIssues = Effect.fn("GitHubApp.listIssues")(function* (
      input: GitHubRepositoryBinding & { since: string; page: number; perPage: number },
    ) {
      const current = yield* binding(input.repository);
      const token = yield* credential({ ...input, generation: current.generation, write: false });
      const raw = yield* request(
        token,
        `repos/${input.repository}/issues?state=open&sort=updated&direction=asc&since=${encodeURIComponent(input.since)}&page=${input.page}&per_page=${Math.min(100, input.perPage)}`,
      );
      const items = yield* decodeIssues(raw).pipe(Effect.mapError(unavailable));
      return {
        items: items.map((item) => ({
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body,
          state: item.state,
          updatedAt: item.updated_at,
          createdAt: item.created_at,
          user: item.user,
          labels: item.labels.map((label) => label.name),
          isPullRequest: item.pull_request !== undefined,
        })),
        nextPage: items.length === input.perPage ? input.page + 1 : null,
      };
    });
    const publish = Effect.fn("GitHubApp.publish")(function* (
      input: GitHubRepositoryBinding & {
        generation: number;
        commitSha: string;
        branch: string;
        baseBranch: string;
        operationKey: string;
        title: string;
        authorize: Effect.Effect<void, GitHubAppError>;
      },
    ) {
      const target = yield* binding(input.repository);
      if (target.baseBranch !== input.baseBranch) return yield* denied();
      const token = yield* credential({ ...input, write: true });
      const marker = `<!-- foundry-operation:${NodeCrypto.createHash("sha256").update(input.operationKey).digest("hex")} -->`;
      const decode = Schema.decodeUnknownEffect(PullRequest);
      const check = (pr: typeof PullRequest.Type) =>
        pr.head.sha === input.commitSha &&
        pr.head.ref === input.branch &&
        pr.head.repo?.full_name === input.repository &&
        pr.base.repo.full_name === input.repository &&
        pr.base.ref === input.baseBranch &&
        pr.body?.includes(marker);
      const raw = yield* request(
        token,
        `repos/${input.repository}/pulls?state=all&head=${encodeURIComponent(`${input.repository.split("/")[0]}:${input.branch}`)}&per_page=100`,
      );
      const existing = yield* decodePullRequests(raw).pipe(Effect.mapError(unavailable));
      if (existing.length > 1 || (existing.length === 1 && !check(existing[0]!)))
        return yield* conflict();
      let pr = existing[0];
      if (!pr) {
        // Re-read configuration immediately before mutation; installation credentials never escape this service boundary.
        const fresh = yield* credential({ ...input, write: true });
        yield* input.authorize;
        pr = yield* request(fresh, `repos/${input.repository}/pulls`, {
          title: input.title,
          body: `Verified Foundry workflow result.\n\nCommit: ${input.commitSha}\n\n${marker}`,
          head: input.branch,
          base: input.baseBranch,
          draft: true,
        }).pipe(
          Effect.flatMap(decode),
          Effect.mapError((error) => (isGitHubAppError(error) ? error : unavailable())),
          Effect.catchTags({
            GitHubAppError: (error) =>
              error.reason !== "conflict"
                ? Effect.fail(error)
                : request(
                    fresh,
                    `repos/${input.repository}/pulls?state=all&head=${encodeURIComponent(`${input.repository.split("/")[0]}:${input.branch}`)}&per_page=100`,
                  ).pipe(
                    Effect.flatMap(decodePullRequests),
                    Effect.flatMap((found) =>
                      found.length === 1 && check(found[0]!)
                        ? Effect.succeed(found[0]!)
                        : Effect.fail(conflict()),
                    ),
                    Effect.mapError((cause) => (isGitHubAppError(cause) ? cause : unavailable())),
                  ),
          }),
        );
      }
      if (!check(pr)) return yield* conflict();
      return {
        number: pr.number,
        url: pr.html_url,
        commitSha: input.commitSha,
        operationKey: input.operationKey,
      };
    });
    return GitHubApp.of({ binding, credential, listIssues, publish, readDefinition });
  }),
);
