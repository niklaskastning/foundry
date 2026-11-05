// @effect-diagnostics nodeBuiltinImport:off -- An isolated fixture key exercises real GitHub App JWT signing without external requests.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as GitHubApp from "./GitHubApp.ts";

const decodeBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCreate = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, head: Schema.String, base: Schema.String }),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sha = "a".repeat(40);
const blob = (content: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
function fixture() {
  const privateKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  let generation = 1;
  let purpose: "automation" | "definitions" | undefined;
  let configured = true;
  let creations = 0;
  let lost = true;
  let rateLimited = false;
  let recorded: unknown = null;
  let staleLookup = false;
  let lookup = () => {};
  const scopes: unknown[] = [];
  const reads: string[] = [];
  let definitionFiles = [
    { path: "definitions/factory.yaml", bytes: Buffer.from("schemaVersion: 1\n") },
  ];
  let treeOverride: unknown;
  let contentsOverride: unknown;
  let beforeRead: (url: string) => Effect.Effect<void> = () => Effect.void;
  const definitionTree = () => ({
    truncated: false,
    tree: [
      { path: "definitions", type: "tree", mode: "040000", sha },
      ...definitionFiles.map((file) => ({
        path: file.path,
        type: "blob",
        mode: "100644",
        sha: blob(file.bytes),
        size: file.bytes.length,
      })),
    ],
  });
  const http = HttpClient.make((request) =>
    Effect.suspend(() => beforeRead(request.url)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const url = new URL(request.url);
          const body =
            request.body._tag === "Uint8Array"
              ? decodeBody(new TextDecoder().decode(request.body.body))
              : null;
          let response: unknown;
          let status = 200;
          if (url.pathname.includes("access_tokens")) {
            scopes.push(body);
            response = {
              token: "installation-only-fixture",
              expires_at: "2099-01-01T00:00:00Z",
              repositories: [{ id: 12, full_name: "owner/test" }],
            };
          } else if (url.pathname.includes("/commits/")) {
            reads.push(request.url);
            response = { sha };
            if (rateLimited) status = 429;
          } else if (url.pathname.includes("/git/trees/")) {
            reads.push(request.url);
            response = treeOverride ?? definitionTree();
          } else if (url.pathname.includes("/contents/")) {
            reads.push(request.url);
            const file = definitionFiles.find((item) =>
              url.pathname.endsWith(`/contents/${item.path}`),
            );
            response =
              contentsOverride ??
              (file
                ? {
                    type: "file",
                    path: file.path,
                    sha: blob(file.bytes),
                    size: file.bytes.length,
                    encoding: "base64",
                    content: file.bytes.toString("base64"),
                  }
                : {});
          } else if (url.pathname.endsWith("/issues")) {
            response = [];
            if (rateLimited) status = 429;
          } else if (request.method === "POST" && recorded) {
            status = 422;
            response = {};
          } else if (request.method === "POST") {
            creations++;
            const decoded = decodeCreate(body);
            recorded = {
              number: 7,
              html_url: "https://github.com/owner/test/pull/7",
              body: decoded.body,
              head: { sha: "a".repeat(40), ref: decoded.head, repo: { full_name: "owner/test" } },
              base: { ref: decoded.base, repo: { full_name: "owner/test" } },
            };
            response = recorded;
            if (lost) {
              lost = false;
              status = 502;
            }
          } else {
            lookup();
            expect(url.searchParams.get("state")).toBe("all");
            response = recorded && !staleLookup ? [recorded] : [];
            staleLookup = false;
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(encode(response), {
              status,
              headers: {
                "content-type": "application/json",
                ...(rateLimited ? { "retry-after": "120" } : {}),
              },
            }),
          );
        }),
      ),
    ),
  );
  const secrets = Secrets.ServerSecretStore.of({
    get: () =>
      Effect.succeed(
        configured
          ? Option.some(
              new TextEncoder().encode(
                encode({
                  appId: "123",
                  installationId: 4,
                  privateKey,
                  generation,
                  repositories: [
                    {
                      id: 12,
                      fullName: "owner/test",
                      bindingKey: "test-binding",
                      baseBranch: "main",
                      ...(purpose === undefined ? {} : { purpose }),
                    },
                  ],
                }),
              ),
            )
          : Option.none(),
      ),
    set: () => Effect.void,
    create: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  const layer = GitHubApp.layer.pipe(
    Layer.provide(Layer.succeed(Secrets.ServerSecretStore, secrets)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return {
    layer,
    scopes,
    reads,
    definitionTree,
    setPurpose: (value: typeof purpose) => {
      purpose = value;
    },
    setTree: (value: unknown) => {
      treeOverride = value;
    },
    setContents: (value: unknown) => {
      contentsOverride = value;
    },
    setFiles: (value: typeof definitionFiles) => {
      definitionFiles = value;
    },
    beforeRead: (callback: typeof beforeRead) => {
      beforeRead = callback;
    },
    revoke: () => {
      generation++;
    },
    remove: () => {
      configured = false;
    },
    rateLimit: () => {
      rateLimited = true;
    },
    creations: () => creations,
    staleLookup: () => {
      staleLookup = true;
    },
    onLookup: (callback: () => void) => {
      lookup = callback;
    },
  };
}
const input = {
  connectionId: "github-app",
  repositoryId: 12,
  repository: "owner/test",
  generation: 1,
  commitSha: "a".repeat(40),
  branch: "foundry/op",
  baseBranch: "main",
  operationKey: "run:step:1",
  title: "Reviewed result",
  authorize: Effect.void,
};
it.effect("reconciles a lost creation response after restart and never creates a second PR", () =>
  Effect.gen(function* () {
    const test = fixture();
    const first = yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      return yield* app.publish(input).pipe(Effect.result);
    }).pipe(Effect.provide(test.layer));
    expect(first._tag).toBe("Failure");
    test.staleLookup();
    const result = yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      return yield* app.publish(input);
    }).pipe(Effect.provide(test.layer));
    expect(result.number).toBe(7);
    expect(test.creations()).toBe(1);
    expect(test.scopes).toContainEqual({
      repository_ids: [12],
      permissions: { contents: "write", pull_requests: "write" },
    });
    const changed = yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      return yield* app.publish({ ...input, commitSha: "b".repeat(40) }).pipe(Effect.result);
    }).pipe(Effect.provide(test.layer));
    expect(changed._tag).toBe("Failure");
    expect(test.creations()).toBe(1);
  }),
);
it.effect(
  "rejects foreign repositories, revoked generations and absent App credentials without fallback",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.gen(function* () {
        const app = yield* GitHubApp.GitHubApp;
        expect(
          (yield* app
            .credential({ ...input, repository: "other/repository", write: true })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        test.revoke();
        expect((yield* app.publish(input).pipe(Effect.result))._tag).toBe("Failure");
        test.remove();
        expect((yield* app.binding("test-binding").pipe(Effect.result))._tag).toBe("Failure");
        expect(test.creations()).toBe(0);
        expect(test.scopes).toHaveLength(0);
      }).pipe(Effect.provide(test.layer));
    }),
);
it.effect("uses read-only issue scope and persists a bounded rate-limit wakeup", () =>
  Effect.gen(function* () {
    const test = fixture();
    test.rateLimit();
    yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      const error = yield* app
        .listIssues({ ...input, since: "2026-11-04T00:00:00Z", page: 1, perPage: 100 })
        .pipe(Effect.flip);
      expect(error.reason).toBe("rate_limited");
      expect(error.retryAt).toBe(120000);
      expect(test.scopes).toContainEqual({ repository_ids: [12], permissions: { issues: "read" } });
      const definitionError = yield* app
        .readDefinition({ ...input, branch: "main", path: "definitions" })
        .pipe(Effect.flip);
      expect(definitionError.reason).toBe("rate_limited");
      expect(definitionError.retryAt).toBe(120000);
      expect(test.scopes).toContainEqual({
        repository_ids: [12],
        permissions: { contents: "read" },
      });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "rechecks workflow authorization after reconciliation and immediately before PR creation",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      let allowed = true;
      test.onLookup(() => {
        allowed = false;
      });
      yield* Effect.gen(function* () {
        const app = yield* GitHubApp.GitHubApp;
        const result = yield* app
          .publish({
            ...input,
            authorize: Effect.suspend(() =>
              allowed
                ? Effect.void
                : Effect.fail(new GitHubApp.GitHubAppError({ reason: "forbidden" })),
            ),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(test.creations()).toBe(0);
      }).pipe(Effect.provide(test.layer));
    }),
);

const definitionInput = { ...input, branch: "main", path: "definitions" };
it.effect("pins all definition contents to one commit with only contents:read", () =>
  Effect.gen(function* () {
    const test = fixture();
    test.setFiles([
      { path: "definitions/factory.yaml", bytes: Buffer.from("schemaVersion: 1\n") },
      { path: "definitions/workflows/build.yaml", bytes: Buffer.from("steps: []\n") },
    ]);
    yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      const result = yield* app.readDefinition(definitionInput);
      expect(result).toEqual({
        commitSha: sha,
        files: [
          { path: "factory.yaml", content: "schemaVersion: 1\n" },
          { path: "workflows/build.yaml", content: "steps: []\n" },
        ],
      });
      expect(test.scopes).toEqual([{ repository_ids: [12], permissions: { contents: "read" } }]);
      expect(test.reads.filter((url) => url.includes("/commits/"))).toHaveLength(1);
      expect(
        test.reads
          .filter((url) => url.includes("/contents/"))
          .every((url) => new URL(url).searchParams.get("ref") === sha),
      ).toBe(true);
      expect(test.reads).toContain(
        `https://api.github.com/repos/owner/test/git/trees/${sha}?recursive=1`,
      );
      const foreign = yield* app
        .readDefinition({ ...definitionInput, repositoryId: 99 })
        .pipe(Effect.flip);
      expect(foreign.reason).toBe("forbidden");
      test.revoke();
      expect((yield* app.readDefinition(definitionInput).pipe(Effect.flip)).reason).toBe(
        "forbidden",
      );
      expect(test.scopes).toHaveLength(1);
    }).pipe(Effect.provide(test.layer));
  }),
);
it.effect(
  "rejects missing, truncated, unsafe and oversized definition trees before downloading files",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      const tree = test.definitionTree();
      const entry = tree.tree[1]!;
      const cases = [
        { ...tree, truncated: true },
        { ...tree, tree: Array.from({ length: 4097 }, () => entry) },
        { ...tree, tree: [] },
        { ...tree, tree: tree.tree.slice(0, 1) },
        ...[
          { mode: "120000" },
          { mode: "160000", type: "commit" },
          { path: "definitions/../factory.yaml" },
          { size: 256 * 1024 + 1 },
          { size: -1 },
          { size: undefined },
        ].map((change) => ({ ...tree, tree: [tree.tree[0], { ...entry, ...change }] })),
        { ...tree, tree: [...tree.tree, entry] },
        {
          ...tree,
          tree: [
            ...tree.tree,
            ...Array.from({ length: 101 }, (_, i) => ({ ...entry, path: `definitions/${i}.yaml` })),
          ],
        },
        {
          ...tree,
          tree: [
            ...tree.tree,
            ...Array.from({ length: 9 }, (_, i) => ({
              ...entry,
              size: 256 * 1024,
              path: `definitions/${i}.yaml`,
            })),
          ],
        },
      ];
      yield* Effect.gen(function* () {
        const app = yield* GitHubApp.GitHubApp;
        for (const value of cases) {
          test.setTree(value);
          expect((yield* app.readDefinition(definitionInput).pipe(Effect.flip)).reason).toBe(
            "unavailable",
          );
        }
        expect(test.reads.some((url) => url.includes("/contents/"))).toBe(false);
      }).pipe(Effect.provide(test.layer));
    }),
);
it.effect("rejects malformed contents, mismatched Git objects and invalid UTF-8", () =>
  Effect.gen(function* () {
    const test = fixture();
    const bytes = Buffer.from("schemaVersion: 1\n");
    const file = {
      type: "file",
      path: "definitions/factory.yaml",
      sha: blob(bytes),
      size: bytes.length,
      encoding: "base64",
      content: bytes.toString("base64"),
    };
    yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      for (const value of [
        {},
        { ...file, content: "!!!!" },
        { ...file, sha },
        { ...file, path: "elsewhere.yaml" },
        { ...file, content: Buffer.alloc(bytes.length).toString("base64") },
        { ...file, size: 0 },
        { ...file, encoding: "none" },
      ]) {
        test.setContents(value);
        expect((yield* app.readDefinition(definitionInput).pipe(Effect.flip)).reason).toBe(
          "unavailable",
        );
      }
      test.setContents(undefined);
      test.setFiles([{ path: "definitions/factory.yaml", bytes: Buffer.from([0xff]) }]);
      expect((yield* app.readDefinition(definitionInput).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
    }).pipe(Effect.provide(test.layer));
  }),
);
it.effect("discards a definition response when the App generation is revoked in flight", () =>
  Effect.gen(function* () {
    const test = fixture();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    test.beforeRead((url) =>
      url.includes("/contents/")
        ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const app = yield* GitHubApp.GitHubApp;
      const fiber = yield* app
        .readDefinition(definitionInput)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      test.revoke();
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("forbidden");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "allows definition-only repositories to read definitions but never mint issue or publishing credentials",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      test.setPurpose("definitions");
      yield* Effect.gen(function* () {
        const app = yield* GitHubApp.GitHubApp;
        for (const operation of [
          app.credential({ ...input, write: true }).pipe(Effect.asVoid),
          app.credential({ ...input, write: false }).pipe(Effect.asVoid),
          app
            .listIssues({ ...input, since: "2026-11-04T00:00:00Z", page: 1, perPage: 100 })
            .pipe(Effect.asVoid),
          app.publish(input).pipe(Effect.asVoid),
        ]) {
          expect((yield* operation.pipe(Effect.flip)).reason).toBe("forbidden");
        }
        expect(test.scopes).toHaveLength(0);
        expect(test.creations()).toBe(0);
        expect((yield* app.readDefinition(definitionInput)).commitSha).toBe(sha);
        expect(test.scopes).toEqual([{ repository_ids: [12], permissions: { contents: "read" } }]);
      }).pipe(Effect.provide(test.layer));
    }),
);
