import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  FoundryInstanceId,
  FoundryArtifactId,
  ThreadId,
  type FoundryArtifactManifest,
} from "@t3tools/contracts";
import { artifactSha256 } from "@t3tools/shared/foundryArtifacts";
import * as Base64 from "effect/encoding/Base64";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useAssetUrlState, useAssetUrls } from "../assets/assetUrls";

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
const binding = {
  origin: "https://main.example.test",
  issuer: "https://team.cloudflareaccess.com",
  instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
  mainEnvironmentId: EnvironmentId.make("main"),
};
vi.mock("./onboarding", () => ({ initialState: () => ({ binding }) }));
vi.mock("~/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    usePreparedConnection: () => ({ _tag: "None" }),
    environmentSession: {
      preparedConnectionValueAtom: () => Atom.make({ _tag: "None" }),
      initialConfigValueAtom: () => Atom.make(null),
    },
  };
});
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: false, isPending: false, error: null }),
}));
vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.effectDiscard(
        Effect.die(new Error("This standalone page has no environment connection.")),
      ),
    ),
  };
});
vi.mock("~/lib/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const { FetchHttpClient } = await import("effect/http");
  return {
    appAtomRuntime: Atom.runtime(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (...args) => fixture.fetch(...args))),
      ),
    ),
  };
});
vi.mock("./instanceSession", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { FoundryInstanceSession } = await import("@t3tools/client-runtime/connection");
  return {
    layerFoundryInstanceSession: Layer.succeed(FoundryInstanceSession, {
      current: (value) =>
        Effect.succeed({ binding: value, csrfToken: "fixture-csrf", authorization: null }),
    }),
  };
});

function setup() {
  const bytes = new TextEncoder().encode(
    "<html><script>globalThis.untrustedArtifact = true</script></html>",
  );
  const manifest: FoundryArtifactManifest = {
    reference: {
      instanceId: binding.instanceId,
      artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
      owner: {
        environmentId: EnvironmentId.make("removed-worker"),
        threadId: ThreadId.make("thread"),
      },
    },
    name: "report.html",
    mimeType: "text/html",
    sizeBytes: bytes.byteLength,
    sha256: artifactSha256(bytes),
  };
  const operations: string[] = [];
  fixture.fetch.mockReset().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(binding.origin);
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("manual");
    if (url.pathname === "/.well-known/foundry")
      return Response.json({
        protocolVersion: "1",
        ...binding,
        capabilities: ["foundry.instance-descriptor", "foundry.access-sessions"],
        negotiatedCapabilities: [],
        instanceAuth: {
          publicOrigin: binding.origin,
          issuer: binding.issuer,
          bootstrapMethods: ["cloudflare-access-jwt"],
          sessionMethods: ["foundry-session-cookie"],
        },
        auth: { bootstrapMethods: ["one-time-token"], sessionMethods: ["browser-session-cookie"] },
        artifactTransfer: { protocolVersion: "1", chunkBytes: 262144, maxBytes: 52428800 },
      });
    expect(url.pathname).toBe("/api/foundry/artifacts");
    expect(new Headers(init.headers).get("x-foundry-csrf")).toBe("fixture-csrf");
    const request = await new Response(init.body).json();
    operations.push(request.op);
    return Response.json(
      request.op === "metadata"
        ? manifest
        : {
            offset: 0,
            total: bytes.byteLength,
            fileSha256: manifest.sha256,
            sha256: manifest.sha256,
            data: Base64.encode(bytes),
          },
    );
  });
  return { manifest, bytes, operations };
}

function Preview({ manifest, label }: { manifest: FoundryArtifactManifest; label: string }) {
  const state = useAssetUrlState(manifest.reference.owner.environmentId, {
    _tag: "attachment",
    attachmentId: "source-id",
    foundryArtifact: manifest,
  });
  return state._tag === "Success" ? <a href={state.url}>{label}</a> : <span>{state._tag}</span>;
}
function CollectionPreview({
  manifest,
  label,
}: {
  manifest: FoundryArtifactManifest;
  label: string;
}) {
  const urls = useAssetUrls(manifest.reference.owner.environmentId, [
    { _tag: "attachment", attachmentId: "source-id", foundryArtifact: manifest },
  ]);
  return urls[0] ? <a href={urls[0]}>{label}</a> : <span>Loading</span>;
}

it.each(["single", "collection"])(
  "loads Main bytes without registering or connecting the source worker (%s)",
  async (mode) => {
    const Component = mode === "single" ? Preview : CollectionPreview;
    const { manifest, bytes, operations } = setup();
    const firstRegistry = AtomRegistry.make();
    const secondRegistry = AtomRegistry.make();
    using _registries = {
      [Symbol.dispose]() {
        firstRegistry.dispose();
        secondRegistry.dispose();
      },
    };
    await using first = await render(
      <RegistryContext.Provider value={firstRegistry}>
        <Component manifest={manifest} label="first file" />
      </RegistryContext.Provider>,
    );
    await expect.element(first.getByRole("link", { name: "first file" })).toBeVisible();
    const firstUrl = first.container.querySelector("a")!.href;
    const response = await fetch(firstUrl);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await first.unmount();
    await vi.waitFor(() => expect(fetch(firstUrl)).rejects.toThrow());
    await using second = await render(
      <RegistryContext.Provider value={secondRegistry}>
        <Component manifest={manifest} label="second file" />
      </RegistryContext.Provider>,
    );
    await expect.element(second.getByRole("link", { name: "second file" })).toBeVisible();
    const secondUrl = second.container.querySelector("a")!.href;
    expect(secondUrl).not.toBe(firstUrl);
    expect(new Uint8Array(await (await fetch(secondUrl)).arrayBuffer())).toEqual(bytes);
    expect(operations).toEqual(["metadata", "read", "metadata", "read"]);
  },
);
