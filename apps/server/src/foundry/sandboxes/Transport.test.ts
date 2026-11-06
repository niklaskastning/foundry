import { FoundrySandboxMachineRequest, FoundryArtifactMachineRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { verifyArtifactRequest } from "../ArtifactProof.ts";
import { verifySandboxRequest } from "./Proof.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";
import { generateDeviceKey } from "../DeviceProof.ts";
import * as Transport from "./Transport.ts";

const publicCaPem = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;
const decodeEnvelope = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Union([FoundrySandboxMachineRequest, FoundryArtifactMachineRequest]),
  ),
);
it.live.each([undefined, "http://127.0.0.1:43123", "http://[::1]:43123"])(
  "bounds responses and preserves canonical proof using host transport %s",
  (connectOrigin) =>
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
          assert.equal(
            request.url,
            `${connectOrigin ?? "https://example.test"}/api/foundry/devices/channel`,
          );
          assert.equal(request.headers["cf-access-client-secret"], undefined);
          const envelope =
            request.body._tag === "Uint8Array"
              ? decodeEnvelope(new TextDecoder().decode(request.body.body))
              : assert.fail("Expected JSON body");
          const verify =
            envelope.protocolVersion === "sandbox-1"
              ? verifySandboxRequest("https://example.test", envelope, key.publicKey)
              : verifyArtifactRequest("https://example.test", envelope, key.publicKey);
          assert.isTrue(verify);
          if (connectOrigin)
            assert.isFalse(
              envelope.protocolVersion === "sandbox-1"
                ? verifySandboxRequest(connectOrigin, envelope, key.publicKey)
                : verifyArtifactRequest(connectOrigin, envelope, key.publicKey),
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
        assert.equal(service.origin, "https://example.test");
        assert.equal(service.publicCaPem, publicCaPem);
        const request = { op: "claim" as const, leaseId: "33333333-3333-4333-8333-333333333333" };
        assert.equal(yield* service.send(request), "ä");
        assert.equal(yield* service.artifactSend({ op: "list", input: {} }), "ä");
        oversized = true;
        const result = yield* service.send(request).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_request");
        assert.isAtMost(pulls, 2);
      }).pipe(
        Effect.provide(
          Transport.layer({
            origin: "https://example.test",
            controlTls: { hostname: "example.test", bridgeAddress: "172.28.0.1", publicCaPem },
            ...(connectOrigin ? { connectOrigin } : {}),
            registrationFile: `${dir}/device`,
            keyFile: `${dir}/key`,
            maxCpuMillis: 1000,
            maxMemoryMiB: 1024,
            maxPids: 128,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      if (!connectOrigin) {
        const invalid = [
          {
            origin: "https://example.test:8443",
            controlTls: { hostname: "example.test", bridgeAddress: "172.28.0.1", publicCaPem },
          },
          { connectOrigin: "http://localhost:43123" },
          { connectOrigin: "http://127.0.0.2:43123" },
          { connectOrigin: "http://2130706433:43123" },
          { connectOrigin: "http://127.0.0.1:43123/" },
          { connectOrigin: "http://127.0.0.1:43123?secret=x" },
          { connectOrigin: "http://127.0.0.1:43123#fragment" },
          { connectOrigin: "http://user@127.0.0.1:43123" },
          { connectOrigin: "https://127.0.0.1:43123" },
          { connectOrigin: "http://127.0.0.1:65536" },
          { connectOrigin: "http://127.0.0.1:80" },
          { connectOrigin: "http://127.0.0.1:43123", accessFile: "/unused-access" },
          { controlTls: { hostname: "other.test", bridgeAddress: "172.28.0.1", publicCaPem } },
          {
            controlTls: {
              hostname: "example.test",
              bridgeAddress: "172.28.0.1",
              publicCaPem: `${publicCaPem}${publicCaPem}`,
            },
          },
          {
            controlTls: {
              hostname: "example.test",
              bridgeAddress: "172.28.0.1",
              publicCaPem: "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----\n",
            },
          },
        ];
        for (const override of invalid) {
          const result = yield* Transport.Transport.pipe(
            Effect.provide(
              Transport.layer({
                origin: "https://example.test",
                registrationFile: `${dir}/device`,
                keyFile: `${dir}/key`,
                maxCpuMillis: 1000,
                maxMemoryMiB: 1024,
                maxPids: 128,
                ...override,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.result,
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal("code" in result.failure ? result.failure.code : null, "invalid_request");
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
