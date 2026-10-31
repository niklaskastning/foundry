import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { FoundryDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as InstanceIdentityStore from "./InstanceIdentityStore.ts";
import * as InstanceDescriptor from "./InstanceDescriptor.ts";
import * as FoundryHttp from "./http.ts";

const isDescriptor = Schema.is(FoundryDescriptor);

const descriptorLayer = InstanceDescriptor.layer.pipe(
  Layer.provide(InstanceIdentityStore.layerFile),
  Layer.provide(EnvironmentAuthPolicy.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
);
const request = { protocolVersion: "1", capabilities: [], requiredCapabilities: [] };
const readDescriptor = Effect.gen(function* () {
  const service = yield* InstanceDescriptor.InstanceDescriptor;
  return yield* service.negotiate(request);
});

it.layer(NodeServices.layer)("Foundry descriptor", (it) => {
  it.effect("preserves the identity across independent concurrent initializers and restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.makeTempDirectoryScoped();
      const initialize = () =>
        readDescriptor.pipe(
          Effect.provide(
            descriptorLayer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), base))),
          ),
        );
      const descriptors = yield* Effect.all(Array.from({ length: 16 }, initialize), {
        concurrency: "unbounded",
      });
      const restarted = yield* initialize();
      for (const descriptor of descriptors) expect(descriptor).toEqual(restarted);
      expect(isDescriptor(restarted)).toBe(true);
      expect(Object.keys(restarted).sort()).toEqual([
        "auth",
        "capabilities",
        "instanceId",
        "mainEnvironmentId",
        "negotiatedCapabilities",
        "protocolVersion",
      ]);
      expect(restarted.auth).toEqual({
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
      });
      const another = yield* fs.makeTempDirectoryScoped();
      const independent = yield* readDescriptor.pipe(
        Effect.provide(
          descriptorLayer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), another))),
        ),
      );
      expect(independent.instanceId).not.toBe(restarted.instanceId);
    }),
  );

  it.effect.each(["", "not-an-id", "00000000-broken"])(
    "does not replace corrupt identity %j",
    (content) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const file = `${config.stateDir}/foundry-instance-id`;
        yield* fs.writeFileString(file, content);
        const result = yield* readDescriptor.pipe(Effect.provide(descriptorLayer), Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* fs.readFileString(file)).toBe(content);
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-corrupt-" })),
      ),
  );

  it.effect(
    "negotiates optional and required capabilities without advertising planned features",
    () =>
      Effect.gen(function* () {
        const service = yield* InstanceDescriptor.InstanceDescriptor;
        const descriptor = yield* service.negotiate({
          ...request,
          capabilities: [
            "foundry.gateway",
            "foundry.instance-descriptor",
            "foundry.instance-descriptor",
          ],
        });
        expect(descriptor.capabilities).toEqual(["foundry.instance-descriptor"]);
        expect(descriptor.negotiatedCapabilities).toEqual(["foundry.instance-descriptor"]);
        const required = yield* service.negotiate({
          ...request,
          requiredCapabilities: ["foundry.instance-descriptor"],
        });
        expect(required.negotiatedCapabilities).toEqual(["foundry.instance-descriptor"]);
      }).pipe(
        Effect.provide(
          descriptorLayer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-negotiate-" })),
          ),
        ),
      ),
  );

  it.effect("serves explicit HTTP errors and a secret-free descriptor with no caching", () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(
        HttpRouter.serve(FoundryHttp.layer.pipe(Layer.provide(descriptorLayer)), {
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "foundry-http-" })),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      for (const [query, status, code] of [
        ["", 400, "protocol_version_required"],
        ["?protocolVersion=", 400, "protocol_version_required"],
        ["?protocolVersion=2", 409, "protocol_version_unsupported"],
        ["?protocolVersion=garbage", 409, "protocol_version_unsupported"],
        ["?protocolVersion=1&protocolVersion=2", 400, "protocol_version_required"],
        ["?protocolVersion=1&requiredCapability=foundry.gateway", 409, "capability_unsupported"],
      ] as const) {
        const response = yield* client.execute(
          HttpClientRequest.get(`/.well-known/foundry${query}`),
        );
        expect(response.status).toBe(status);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(yield* response.json).toMatchObject({
          code,
          message: expect.any(String),
          supportedProtocolVersions: ["1"],
        });
      }
      const response = yield* client.execute(
        HttpClientRequest.get("/.well-known/foundry?protocolVersion=1"),
      );
      expect(response.status).toBe(200);
      const body = yield* response.json;
      expect(isDescriptor(body)).toBe(true);
      expect(response.headers["cache-control"]).toBe("no-store");
    }).pipe(Effect.scoped),
  );
});
