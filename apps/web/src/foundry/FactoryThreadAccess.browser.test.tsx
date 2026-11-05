import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { render } from "../../test/render";
import { FactoryThreadAccess } from "./FactoryThreadAccess";

const mocks = vi.hoisted(() => ({ environments: [] as { environmentId: string }[], run: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Connection failed"),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments, isReady: true }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.run }));
vi.mock("./devices", () => ({ deviceCommand: {} }));
vi.mock("../lib/utils", () => ({
  randomUUID: () => crypto.randomUUID(),
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("../components/ui/sidebar", () => ({ SidebarInset: "main" }));

const worker = EnvironmentId.make("worker");
function setup() {
  mocks.environments = [];
  mocks.run.mockReset();
}
function view(factoryId: string | undefined = "factory") {
  return (
    <FactoryThreadAccess environmentId={worker} factoryId={factoryId} runId="run">
      <p>Thread content</p>
    </FactoryThreadAccess>
  );
}

it("keeps an unconnected factory deep link recoverable without navigating away from its thread", async () => {
  setup();
  mocks.run.mockResolvedValue(
    AsyncResult.success({
      catalog: {
        devices: [
          {
            deviceId: "device",
            environmentId: worker,
            revoked: false,
            online: true,
            rpcReady: true,
            clientAccess: { enabled: true },
          },
        ],
      },
    }),
  );
  const url = "/worker/thread?factoryId=factory&runId=run";
  await using screen = await render(view(), { router: url });
  await expect
    .element(screen.getByRole("heading", { name: "Connect to the run’s worker" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "← Back to factory run" }))
    .toHaveAttribute("href", "/foundry?view=factories&factoryId=factory&runId=run&tab=runs");
  await screen.getByRole("button", { name: "Connect to worker" }).click();
  await expect
    .element(screen.getByText("Worker selected. Connecting to this thread…"))
    .toBeVisible();
  expect(mocks.run.mock.calls.map(([input]) => input.type)).toEqual(["load", "select"]);
  expect(screen.router?.state.location.href).toBe(url);
  mocks.environments = [{ environmentId: worker }];
  await screen.rerender(view());
  await expect.element(screen.getByText("Thread content")).toBeVisible();
  expect(screen.router?.state.location.href).toBe(url);
});

it.each([
  { devices: [], message: "This worker is not registered" },
  {
    devices: [
      {
        environmentId: worker,
        revoked: false,
        online: true,
        rpcReady: true,
        clientAccess: { enabled: false },
      },
    ],
    message: "Interactive access to this worker is not authorized",
  },
  {
    devices: [
      {
        environmentId: worker,
        revoked: false,
        online: false,
        rpcReady: false,
        clientAccess: { enabled: true },
      },
    ],
    message: "This worker is offline",
  },
])(
  "keeps the return path when the worker cannot be connected: $message",
  async ({ devices, message }) => {
    setup();
    mocks.run.mockResolvedValue(AsyncResult.success({ catalog: { devices } }));
    await using screen = await render(view());
    await screen.getByRole("button", { name: "Connect to worker" }).click();
    await expect.element(screen.getByText(message, { exact: false })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "← Back to factory run" })).toBeVisible();
    expect(mocks.run.mock.calls.map(([input]) => input.type)).toEqual(["load"]);
  },
);

it("leaves ordinary thread links unchanged", async () => {
  setup();
  await using screen = await render(
    <FactoryThreadAccess environmentId={worker}>
      <p>Thread content</p>
    </FactoryThreadAccess>,
  );
  await expect.element(screen.getByText("Thread content")).toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
});
