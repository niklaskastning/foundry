import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  ProjectId,
  type AutomationApplicationQuery,
  type FactoryDefinitionVersion,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { WorkItemDetail } from "./WorkItemDetail";

const mocks = vi.hoisted(() => ({ query: vi.fn(), command: vi.fn(), uuid: vi.fn() }));
vi.mock("../../lib/utils", () => ({
  randomUUID: mocks.uuid,
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("./commands", () => ({ automationCommands: { command: { permissionAtom: () => null } } }));
vi.mock("./useAutomationQuery", () => ({ useAutomationQuery: mocks.query }));
vi.mock("./HandoffPanel", () => ({ HandoffList: () => null }));
vi.mock("./RunList", () => ({ RunList: () => null }));
vi.mock("./AgentCatalog", () => ({ WorkflowConfiguration: () => null }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Connection lost"),
}));

it("replays the saved start after an unconfirmed response even when current readiness and defaults disappear", async () => {
  mocks.query.mockReset();
  let sequence = 0;
  mocks.uuid.mockReset().mockImplementation(() => `command-${++sequence}`);
  mocks.command.mockReset();
  const item = {
    id: "work",
    factoryId: "factory",
    versionId: "version",
    repository: "repo",
    title: "Fix the build",
    source: { kind: "manual", reference: "request" },
    state: "open",
  };
  const defaults = {
    kind: "executionDefaults",
    defaults: {
      factoryId: "factory",
      repository: "repo",
      projectId: ProjectId.make("project"),
      model: "gpt-test",
      checks: [],
      requiredArtifacts: [],
      generation: 1,
    },
  };
  const worker = {
    kind: "workerBinding",
    projects: [{ id: "project", title: "Project", workspaceRoot: "/project" }],
    status: { providerReady: true, providerState: "ready", activeRuns: 0 },
  };
  const active: FactoryDefinitionVersion = {
    id: "definition",
    commandId: "definition",
    factoryId: "factory",
    factoryVersionId: "version",
    scopeVersionId: "scope",
    contentHash: "a".repeat(64),
    source: { kind: "files", reference: "test" },
    definition: {
      schemaVersion: 1,
      factoryId: "factory",
      repositories: ["repo"],
      workflows: [
        {
          id: "implement",
          steps: [{ id: "work", kind: "agent", prompt: "Implement", dependsOn: [] }],
        },
      ],
    },
    workflowVersions: [{ id: "implement", versionId: "workflow" }],
  };
  const refresh = vi.fn();
  mocks.query.mockImplementation(
    (_environment: EnvironmentId, input: AutomationApplicationQuery) => ({
      result:
        input.op === "workItem"
          ? { kind: "workItem", item }
          : input.op === "workerBinding"
            ? worker
            : defaults,
      loading: false,
      error: null,
      refresh,
    }),
  );
  mocks.command.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Connection lost"))));
  const environmentId = EnvironmentId.make("main");
  await using screen = await render(
    <WorkItemDetail
      environmentId={environmentId}
      factoryId="factory"
      workItemId="work"
      active={active}
      onOpenRun={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "Authorize and start workflow" }).click();
  await expect.element(screen.getByRole("button", { name: "Retry the same start" })).toBeEnabled();
  const sent = mocks.command.mock.calls[0]?.[0];
  mocks.query.mockImplementation(
    (_environment: EnvironmentId, input: AutomationApplicationQuery) => ({
      result: input.op === "workItem" ? { kind: "workItem", item } : null,
      loading: false,
      error: input.op === "workItem" ? null : "Worker offline",
      refresh,
    }),
  );
  await screen.rerender(
    <WorkItemDetail
      environmentId={environmentId}
      factoryId="factory"
      workItemId="work"
      active={null}
      onOpenRun={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Retry the same start" })).toBeEnabled();
  await screen.getByRole("button", { name: "Retry the same start" }).click();
  expect(mocks.command.mock.calls[1]?.[0]).toEqual(sent);
});
