// @effect-diagnostics nodeBuiltinImport:off -- An isolated fixture key exercises real GitHub App JWT signing without external requests.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
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
function fixture() {
  const privateKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  let generation = 1;
  let configured = true;
  let creations = 0;
  let lost = true;
  let rateLimited = false;
  let recorded: unknown = null;
  let staleLookup = false;
  let lookup = () => {};
  const scopes: unknown[] = [];
  const http = HttpClient.make((request) =>
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
