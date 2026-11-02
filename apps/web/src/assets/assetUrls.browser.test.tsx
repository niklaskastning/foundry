import { RegistryContext } from "@effect/atom-react";
import { materializeAssetQuery } from "@t3tools/client-runtime/state/assets";
import { type AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useAssetUrlRefresh } from "./assetUrls";

const { createUrl } = vi.hoisted(() => ({ createUrl: vi.fn() }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl } }));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://main.test/api/foundry/gateway/devices/worker/" },
  }),
}));
vi.mock("~/state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: true }) }));

function setup() {
  const source = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult & { foundry: boolean }>>(
    AsyncResult.success({
      relativeUrl: "/api/assets/token/attachment.txt",
      expiresAt: 4_000_000_000_000,
      foundry: true,
    }),
  );
  const bytes = new TextEncoder().encode("Foundry Attachment-Test");
  let downloads = 0;
  const asset = materializeAssetQuery(source, () =>
    Effect.sync(() => {
      downloads += 1;
      return bytes;
    }),
  );
  createUrl.mockReset().mockReturnValue(asset);
  return { first: AtomRegistry.make(), second: AtomRegistry.make(), downloads: () => downloads };
}

function Preview({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const refresh = useAssetUrlRefresh(environmentId, {
    _tag: "attachment",
    attachmentId: "attachment",
  });
  const [url, setUrl] = useState<string | null>(null);
  return (
    <>
      <button onClick={async () => setUrl(await refresh())}>Load {label}</button>
      {url ? <a href={url}>{label}</a> : null}
    </>
  );
}

it("keeps refreshed Foundry attachment URLs readable in two clients until each preview closes", async () => {
  const registries = setup();
  using _registries = {
    [Symbol.dispose]: () => {
      registries.first.dispose();
      registries.second.dispose();
    },
  };
  await using first = await render(
    <RegistryContext.Provider value={registries.first}>
      <Preview environmentId={EnvironmentId.make("worker")} label="first attachment" />
    </RegistryContext.Provider>,
  );
  await using second = await render(
    <RegistryContext.Provider value={registries.second}>
      <Preview environmentId={EnvironmentId.make("worker")} label="second attachment" />
    </RegistryContext.Provider>,
  );
  expect(registries.downloads()).toBe(0);
  await userEvent.click(first.getByRole("button", { name: "Load first attachment" }));
  await userEvent.click(second.getByRole("button", { name: "Load second attachment" }));
  await expect.element(first.getByRole("link", { name: "first attachment" })).toBeVisible();
  await expect.element(second.getByRole("link", { name: "second attachment" })).toBeVisible();
  const firstUrl = first.container.querySelector("a")!.href;
  const secondUrl = second.container.querySelector("a")!.href;
  expect(firstUrl).not.toBe(secondUrl);
  expect(await (await fetch(firstUrl)).text()).toBe("Foundry Attachment-Test");
  expect(await (await fetch(secondUrl)).text()).toBe("Foundry Attachment-Test");
  await first.unmount();
  await vi.waitFor(async () => expect(fetch(firstUrl)).rejects.toThrow());
  expect(await (await fetch(secondUrl)).text()).toBe("Foundry Attachment-Test");
  await second.unmount();
  await vi.waitFor(async () => expect(fetch(secondUrl)).rejects.toThrow());
});
