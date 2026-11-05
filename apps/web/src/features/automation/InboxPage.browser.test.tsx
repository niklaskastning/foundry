import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { InboxPage } from "./InboxPage";

const mocks = vi.hoisted(() => ({ allowed: false, readable: false, command: vi.fn() }));
vi.mock("../../lib/utils", () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("@effect/atom-react", async () => {
  const { createContext } = await import("react");
  return { RegistryContext: createContext(null), useAtomValue: () => mocks.allowed };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.command }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
  sessionHasScope: () => mocks.readable,
}));
vi.mock("../../foundry/useWorkspaceNavigation", () => ({
  useWorkspaceNavigation: () => ({ search: {}, update: vi.fn() }),
}));
vi.mock("./commands", () => ({
  automationCommands: { inboxQuery: { permissionAtom: () => null } },
}));
vi.mock("./ListFilters", () => ({ ListFilters: () => null }));
vi.mock("./InboxDetail", () => ({ InboxDetail: () => null }));

function setup(allowed: boolean, readable: boolean) {
  mocks.allowed = allowed;
  mocks.readable = readable;
  mocks.command.mockReset();
}

it.each([
  { allowed: false, readable: true },
  { allowed: true, readable: false },
])(
  "shows an access state instead of waiting for an inbox request that cannot run ($allowed, $readable)",
  async ({ allowed, readable }) => {
    setup(allowed, readable);
    await using screen = await render(
      <InboxPage environmentId={EnvironmentId.make("main")} compact />,
    );
    await expect
      .element(screen.getByText("Connect to Main with read permission to open your inbox."))
      .toBeVisible();
    await expect.element(screen.getByText("Loading inbox…")).not.toBeInTheDocument();
    expect(mocks.command).not.toHaveBeenCalled();
  },
);
