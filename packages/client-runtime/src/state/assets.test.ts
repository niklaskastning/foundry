// @effect-diagnostics globalFetch:off globalFetchInEffect:off - Verify the lifetime of local blob URLs without an HTTP server.
import { describe, expect, it } from "@effect/vitest";
import { type AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { executeAtomQuery } from "./runtime.ts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  createProjectFaviconUrlAtomFamily,
  materializeAssetQuery,
  resolveAssetUrl,
} from "./assets.ts";

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "releases materialized bytes when its source disconnects without revoking another environment",
  () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const source = Atom.make<
        AsyncResult.AsyncResult<AssetCreateUrlResult & { foundry: boolean }, string>
      >(
        AsyncResult.success({
          foundry: true,
          relativeUrl: "/api/assets/token/file.png",
          expiresAt: 42,
        }),
      );
      const otherSource = Atom.make(
        AsyncResult.success({
          foundry: true,
          relativeUrl: "/api/assets/other/file.png",
          expiresAt: 42,
        }),
      );
      const bytes = new Uint8Array([1, 2, 3]);
      const asset = materializeAssetQuery(source, () => Effect.succeed(bytes));
      const other = materializeAssetQuery(otherSource, () => Effect.succeed(bytes));
      const stops = [registry.mount(asset), registry.mount(other)];
      yield* Effect.addFinalizer(() => Effect.sync(() => stops.forEach((stop) => stop())));
      const read = (atom: typeof asset) =>
        Effect.promise(() => executeAtomQuery(registry, atom, { reportFailure: false }));
      const first = yield* read(asset);
      const second = yield* read(other);
      expect(first._tag).toBe("Success");
      expect(second._tag).toBe("Success");
      if (first._tag !== "Success" || second._tag !== "Success") return;
      registry.set(source, AsyncResult.failure(Cause.fail("disconnected")));
      expect((yield* read(asset))._tag).toBe("Failure");
      yield* Effect.promise(async () => {
        await expect(fetch(first.value.relativeUrl)).rejects.toThrow();
        expect(new Uint8Array(await (await fetch(second.value.relativeUrl)).arrayBuffer())).toEqual(
          bytes,
        );
      });
    }),
);

it("never resolves a worker HTTP path against Main or a foreign origin", () => {
  const base = "https://main.test/api/foundry/gateway/devices/device/";
  expect(resolveAssetUrl(base, "/api/assets/token/file.png")).toBeNull();
  expect(resolveAssetUrl(base, "https://worker.test/api/assets/token/file.png")).toBeNull();
  expect(resolveAssetUrl(base, "data:text/plain;base64,YQ==")).toBe("data:text/plain;base64,YQ==");
  expect(resolveAssetUrl("https://personal.test/", "/api/assets/token/file.png")).toBe(
    "https://personal.test/api/assets/token/file.png",
  );
});
