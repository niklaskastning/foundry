import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { SandboxRunStatus } from "./SandboxRunStatus";

vi.mock("../../lib/utils", () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return { RegistryContext: createContext(null), useAtomValue: () => true };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.query }));
vi.mock("../../foundry/sandboxes", () => ({
  sandboxCommands: { query: { permissionAtom: () => null } },
}));

it("matches the run owner when an older Main returns an unfiltered list", async () => {
  mocks.query.mockReset().mockImplementation((_registry, _command, { input }) =>
    Promise.resolve(
      AsyncResult.success(
        input.action === "list"
          ? {
              allocations: [
                { allocationId: "other", request: { owner: { kind: "interactive" } } },
                {
                  allocationId: "ours",
                  request: { owner: { kind: "workflow", factoryId: "factory", runId: "run" } },
                },
              ],
            }
          : {
              allocation: {
                allocationId: input.allocationId,
                state: "setup",
                request: { owner: { kind: "workflow", factoryId: "factory", runId: "run" } },
              },
              setupLog: "Pinned setup in progress",
            },
      ),
    ),
  );
  await using screen = await render(
    <SandboxRunStatus
      environmentId={EnvironmentId.make("main")}
      factoryId="factory"
      runId="run"
      target={{ profileId: "linux", revision: "revision" }}
    />,
  );
  await expect.element(screen.getByText("Allocation: ours", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Allocation: other", { exact: true }))
    .not.toBeInTheDocument();
});

it("reports disabled capability instead of waiting for capacity", async () => {
  mocks.query
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ sandboxSupported: false, profiles: [], allocations: [] }),
    );
  await using screen = await render(
    <SandboxRunStatus
      environmentId={EnvironmentId.make("main")}
      factoryId="factory"
      runId="run"
      target={{ profileId: "linux", revision: "revision" }}
    />,
  );
  await expect
    .element(screen.getByText("Sandbox status unavailable. Refresh to retry.", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("pending allocation / capacity")).not.toBeInTheDocument();
});
