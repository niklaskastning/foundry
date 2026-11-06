import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";
import { generateDeviceKey } from "../DeviceProof.ts";
import * as Transport from "./Transport.ts";

it.live(
  "bounds response consumption, preserves split UTF-8 and disables credential redirects",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = generateDeviceKey();
      yield* fs.writeFileString(`${dir}/key`, JSON.stringify(key));
      yield* fs.writeFileString(
        `${dir}/device`,
        JSON.stringify({
          deviceId: "11111111-1111-4111-8111-111111111111",
          instanceId: "22222222-2222-4222-8222-222222222222",
          environmentId: "sandbox-test",
          generation: 1,
          revoked: false,
          publicKey: key.publicKey,
        }),
      );
      let oversized = false;
      let pulls = 0;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          assert.equal(
            Option.getOrThrow(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).redirect,
            "manual",
          );
          const bytes = new TextEncoder().encode('"ä"');
          const stream = oversized
            ? new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulls++;
                  controller.enqueue(new Uint8Array(2097153));
                },
              })
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes.slice(0, 2));
                  controller.enqueue(bytes.slice(2));
                  controller.close();
                },
              });
          return HttpClientResponse.fromWeb(request, new Response(stream));
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Transport.Transport;
        const request = { op: "claim" as const, leaseId: "33333333-3333-4333-8333-333333333333" };
        assert.equal(yield* service.send(request), "ä");
        oversized = true;
        const result = yield* service.send(request).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_request");
        assert.isAtMost(pulls, 2);
      }).pipe(
        Effect.provide(
          Transport.layer({
            origin: "https://example.test",
            registrationFile: `${dir}/device`,
            keyFile: `${dir}/key`,
            maxCpuMillis: 1000,
            maxMemoryMiB: 1024,
            maxPids: 128,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
