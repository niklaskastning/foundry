import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type AutomationApplicationQuery } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { RunDetail } from "./RunDetail";

const mocks = vi.hoisted(() => ({ query: vi.fn(), navigation: vi.fn() }));
vi.mock("../../lib/utils", () => ({
  randomUUID: () => "command",
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./commands", () => ({
  automationCommands: {
    control: { permissionAtom: () => null },
    command: { permissionAtom: () => null },
  },
}));
vi.mock("./useAutomationQuery", () => ({ useAutomationQuery: mocks.query }));
vi.mock("../../foundry/useWorkspaceNavigation", () => ({
  useWorkspaceNavigation: mocks.navigation,
}));
vi.mock("../../components/foundry/SandboxRunStatus", () => ({ SandboxRunStatus: () => null }));
vi.mock("./HandoffPanel", () => ({ HandoffList: () => null, TakeOverPanel: () => null }));
vi.mock("../../components/files/AttachmentFilePreview", () => ({
  AttachmentFilePreview: () => null,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Unavailable"),
}));

it("keeps attempts and selected node results accessible across independent history pages", async () => {
  mocks.navigation.mockReset().mockReturnValue({
    search: { nodeOffset: "100", nodePath: "earlier", attemptId: "attempt-earlier" },
    update: vi.fn(),
  });
  const stoppingNode = {
    path: "stopping",
    scope: "",
    definition: { id: "stopping", kind: "agent" },
    status: "running",
    cancelRequested: true,
    reason: "cancelled",
  };
  mocks.query.mockReset().mockImplementation((_environment, input: AutomationApplicationQuery) => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    result:
      input.op === "run"
        ? {
            kind: "run",
            factoryName: "Delivery",
            workItem: { title: "Review implementation" },
            run: { state: "succeeded", workItemId: "work", repository: "app" },
            control: null,
            workflow: { steps: [{ id: "later", kind: "agent", prompt: "Later", dependsOn: [] }] },
            runtimeWorkflow: { limits: { maxAgentExecutions: 200, maxConcurrentAgents: 2 } },
            runtimeState: {
              startedAgentExecutions: 101,
              nodesTotal: 101,
              nextNodeOffset: null,
              nodes: [
                {
                  path: "later",
                  scope: "",
                  definition: { id: "later", kind: "agent" },
                  status: "succeeded",
                  ordinal: 100,
                },
                stoppingNode,
              ],
            },
          }
        : input.op === "attempts"
          ? {
              kind: "attempts",
              next: null,
              items: [
                {
                  commandId: "attempt-earlier",
                  ordinal: 0,
                  attemptNumber: 0,
                  state: "succeeded",
                  hasResult: true,
                },
                {
                  commandId: "approval",
                  ordinal: 101,
                  attemptNumber: 0,
                  state: "succeeded",
                  hasResult: false,
                },
              ],
            }
          : input.op === "attempt"
            ? {
                kind: "attempt",
                execution: null,
                artifacts: [],
                publish: { url: "https://example.com/pull/42", number: 42, commitSha: "abc" },
              }
            : input.op === "runtimeNode"
              ? {
                  kind: "runtimeNode",
                  node: {
                    path: "earlier",
                    base: "base",
                    output: { summary: "Earlier reviewed output" },
                  },
                }
              : null,
  }));
  await using screen = await render(
    <RunDetail
      environmentId={EnvironmentId.make("main")}
      factoryId="factory"
      runId="run"
      onBack={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("No execution report is attached to this step."))
    .toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Pull request #42" })).toBeVisible();
  await expect.element(screen.getByText("Earlier reviewed output", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Close details", exact: true }))
    .toBeVisible();
  const shutdownMessage = "Stop requested; waiting for confirmed writer shutdown.";
  await expect.element(screen.getByText(shutdownMessage, { exact: true })).toBeVisible();
  for (const status of ["failed", "cancelled", "succeeded"]) {
    stoppingNode.status = status;
    await screen.rerender(
      <RunDetail
        environmentId={EnvironmentId.make("main")}
        factoryId="factory"
        runId="run"
        onBack={() => {}}
      />,
    );
    await expect
      .element(screen.getByText(shutdownMessage, { exact: true }))
      .not.toBeInTheDocument();
  }
});
