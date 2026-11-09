import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { SourceFeaturePanel } from "./SourceFeaturePanel";

const mocks = vi.hoisted(() => ({ query: vi.fn(), command: vi.fn(), refresh: vi.fn() }));
vi.mock("./useAutomationQuery", () => ({ useAutomationQuery: mocks.query }));
vi.mock("./commands", () => ({ automationCommands: { command: { permissionAtom: () => null } } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../../lib/utils", () => ({
  randomUUID: () => "source-command",
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("./DefinitionSourcePanel", () => ({
  DefinitionRevisionComparison: ({ revisionId }: { revisionId: string }) => (
    <p>Comparison {revisionId}</p>
  ),
}));

it("preserves untouched source pins and reviews historical revisions without triggers", async () => {
  mocks.query.mockReset();
  mocks.command.mockReset().mockResolvedValue(AsyncResult.success(null));
  mocks.refresh.mockReset();
  const onChanged = vi.fn();
  const location = {
    connectionId: "github-app",
    repositoryId: 42,
    repository: "owner/defs",
    branch: "release",
    path: "nested/factory",
    commitSha: "a".repeat(40),
  };
  const revisions = ["candidate", "historical"].map((id) => ({
    id,
    commitSha: (id === "candidate" ? "a" : "b").repeat(40),
    valid: true,
    location,
    issues: [],
  }));
  mocks.query.mockImplementation((_, input) => {
    const result =
      input.op === "factory"
        ? {
            kind: "factory",
            active: {
              id: "local",
              scopeVersionId: "scope",
              contentHash: "hash",
              source: { kind: "local" },
              definition: { schemaVersion: 1 },
            },
            versions: [],
          }
        : input.op === "definitionSource"
          ? {
              kind: "definitionSource",
              binding: {
                ...location,
                scopeVersionId: "scope",
                generation: 2,
                ownership: "pending",
                selectedRevisionId: "candidate",
                enabled: true,
                status: "ready",
              },
            }
          : input.op === "definitionRevision"
            ? {
                kind: "definitionRevision",
                revision: revisions.find((revision) => revision.id === input.revisionId),
                files: ["factory.yaml"],
                activeFiles: null,
                activeVersionId: "local",
              }
            : { kind: "definitionRevisions", items: revisions, next: null };
    return { result, error: null, loading: false, refresh: mocks.refresh };
  });
  await using screen = await render(
    <SourceFeaturePanel
      environmentId={EnvironmentId.make("main")}
      factoryId="factory"
      onChanged={onChanged}
    />,
  );
  await expect.element(screen.getByLabelText("Branch", { exact: true })).toHaveValue("release");
  await expect.element(screen.getByLabelText("Definition directory")).toHaveValue("nested/factory");
  await expect
    .element(screen.getByLabelText("Exact commit (optional)"))
    .toHaveValue(location.commitSha);
  await expect.element(screen.getByText("Comparison candidate", { exact: true })).toBeVisible();
  await userEvent.fill(screen.getByLabelText("Repository", { exact: true }), "owner/renamed");
  await screen.getByRole("button", { name: "Save source for synchronization" }).click();
  expect(mocks.command).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ location: { ...location, repository: "owner/renamed" } }),
    }),
  );
  expect(onChanged).toHaveBeenCalledOnce();
  await screen.getByRole("button", { name: "Review revision bbbbbbbb" }).click();
  await expect.element(screen.getByText("Comparison historical", { exact: true })).toBeVisible();
});
