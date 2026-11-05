import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { render } from "../../test/render";
import { ThreadRouteView } from "./ThreadRouteView";

const mocks = vi.hoisted(() => ({
  shell: null as { deletedAt: null } | null,
  error: null as string | null,
  deleted: false,
}));
vi.mock("./ChatView", () => ({ default: () => <p>Connected worker thread</p> }));
vi.mock("./ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../lib/utils", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: object) => unknown) =>
    select({
      getDraftSession: () => null,
      getPromotedDraftRedirect: () => null,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: {
    getState: () => ({ clearPendingFileDropsForThread: () => {} }),
  },
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => mocks.shell,
  useEnvironmentThreadRefs: () => [{ threadId: "other" }],
}));
vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "live" }));
vi.mock("../state/threads", () => ({
  useEnvironmentThread: () => ({
    status: mocks.deleted ? "deleted" : "synchronizing",
    data: Option.none(),
    error: Option.fromNullishOr(mocks.error),
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "worker", connection: { phase: "connected", lastFailure: null } },
    ],
    isReady: true,
  }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../foundry/devices", () => ({ deviceCommand: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => new Error("Connection failed"),
}));

function setup() {
  mocks.shell = null;
  mocks.error = null;
  mocks.deleted = false;
}
function view() {
  return (
    <ThreadRouteView
      target={{
        kind: "server",
        threadRef: {
          environmentId: EnvironmentId.make("worker"),
          threadId: ThreadId.make("thread"),
        },
      }}
      factoryContext={{ factoryId: "factory", runId: "run" }}
    />
  );
}

it("preserves a factory deep link through loading, failure and missing state, then opens ready worker data", async () => {
  setup();
  const url = "/worker/thread?factoryId=factory&runId=run";
  await using screen = await render(view(), { router: url });
  await expect
    .element(screen.getByRole("heading", { name: "Opening worker thread" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "← Back to factory run" }))
    .toHaveAttribute("href", "/foundry?view=factories&factoryId=factory&runId=run&tab=runs");
  mocks.error = "Worker history access denied";
  await screen.rerender(view());
  await expect.element(screen.getByText("Worker history access denied")).toBeVisible();
  mocks.deleted = true;
  await screen.rerender(view());
  await expect
    .element(screen.getByRole("heading", { name: "Thread no longer available" }))
    .toBeVisible();
  expect(screen.router?.state.location.href).toBe(url);
  mocks.deleted = false;
  mocks.error = null;
  mocks.shell = { deletedAt: null };
  await screen.rerender(view());
  await expect.element(screen.getByText("Connected worker thread")).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Opening worker thread" }))
    .not.toBeInTheDocument();
});
