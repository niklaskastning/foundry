import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  type AutomationApplicationQuery,
  type AutomationApplicationResult,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { useAutomationQuery } from "./useAutomationQuery";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@effect/atom-react", async () => ({
  RegistryContext: (await import("react")).createContext(null),
  useAtomValue: () => true,
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
  sessionHasScope: () => true,
}));
vi.mock("./commands", () => ({ automationCommands: { query: {} } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.query,
  squashAtomCommandFailure: () => new Error("Unavailable"),
}));

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function Probe({
  environmentId,
  input,
}: {
  environmentId: EnvironmentId;
  input: AutomationApplicationQuery;
}) {
  const query = useAutomationQuery(environmentId, input);
  return (
    <div>
      <pre data-testid="result">
        {query.result?.kind === "factories"
          ? query.result.items.map((factory) => factory.name).join(", ")
          : "No data"}
      </pre>
      <p role="status">{query.loading ? "Loading" : "Settled"}</p>
      <p role="alert">{query.error ?? "No error"}</p>
      <button onClick={query.refresh}>Refresh</button>
    </div>
  );
}
function factories(name: string) {
  return AsyncResult.success({
    kind: "factories",
    items: [{ id: name, name, archived: false }],
    next: null,
  } satisfies AutomationApplicationResult);
}
it("never exposes another query or environment's data and clears failed results", async () => {
  mocks.query.mockReset();
  const next = deferred();
  const moved = deferred();
  const refresh = deferred();
  mocks.query.mockResolvedValue(factories("First factory"));
  const main = EnvironmentId.make("main");
  await using screen = await render(
    <Probe environmentId={main} input={{ op: "factories", limit: 20 }} />,
  );
  await expect.element(screen.getByTestId("result")).toHaveTextContent("First factory");
  mocks.query.mockReturnValue(next.promise);
  await screen.rerender(
    <Probe environmentId={main} input={{ op: "factories", limit: 20, search: "missing" }} />,
  );
  await expect.element(screen.getByTestId("result")).toHaveTextContent("No data");
  next.resolve(AsyncResult.failure(Cause.fail(new Error("Unavailable"))));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  mocks.query.mockReturnValue(moved.promise);
  await screen.rerender(
    <Probe
      environmentId={EnvironmentId.make("other")}
      input={{ op: "factories", limit: 20, search: "missing" }}
    />,
  );
  await expect.element(screen.getByRole("alert")).toHaveTextContent("No error");
  moved.resolve(factories("Other environment"));
  await expect.element(screen.getByTestId("result")).toHaveTextContent("Other environment");
  mocks.query.mockReturnValue(refresh.promise);
  await screen.getByRole("button", { name: "Refresh" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading");
  await expect.element(screen.getByTestId("result")).toHaveTextContent("Other environment");
  refresh.resolve(AsyncResult.failure(Cause.fail(new Error("Unavailable"))));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  await expect.element(screen.getByTestId("result")).toHaveTextContent("No data");
});
