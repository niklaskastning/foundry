import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  FoundryDeviceId,
  ProjectId,
  type AutomationApplicationQuery,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { WorkerPoolPicker } from "./WorkerPoolPicker";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./useAutomationQuery", () => ({ useAutomationQuery: mocks.query }));

it("recovers a failed worker lookup without discarding selected targets", async () => {
  const healthy = "11111111-1111-4111-8111-111111111111";
  const offline = "22222222-2222-4222-8222-222222222222";
  const workers = [
    {
      deviceId: FoundryDeviceId.make(healthy),
      environmentId: EnvironmentId.make("healthy"),
      projectId: ProjectId.make("selected"),
    },
  ];
  mocks.query
    .mockReset()
    .mockImplementation((_environment: EnvironmentId, input: AutomationApplicationQuery) => ({
      loading: false,
      error: input.op === "workerBinding" && input.deviceId === offline ? "Worker offline" : null,
      result:
        input.op === "workerBinding" && input.deviceId === offline
          ? null
          : {
              kind: "workerBinding",
              deviceId: healthy,
              environmentId: "healthy",
              workers: [
                { deviceId: healthy, environmentId: "healthy" },
                { deviceId: offline, environmentId: "offline" },
              ],
              projects: [{ id: "available", title: "Available", workspaceRoot: "/workspace" }],
              status: { providerReady: true },
            },
      refresh: vi.fn(),
    }));
  await using screen = await render(
    <WorkerPoolPicker
      environmentId={EnvironmentId.make("main")}
      workers={workers}
      onChange={() => {}}
    />,
  );
  await screen.getByRole("combobox").click();
  await screen.getByRole("option", { name: "offline" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await screen.getByRole("button", { name: "Choose default worker" }).click();
  await expect.element(screen.getByRole("button", { name: "Add Available" })).toBeEnabled();
  await expect.element(screen.getByText("healthy · Project selected")).toBeVisible();
});
