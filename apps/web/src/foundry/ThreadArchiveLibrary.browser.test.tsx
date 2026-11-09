import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { ThreadArchiveLibrary } from "./ThreadArchiveLibrary";

const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock("./archives", () => ({ archiveReadCommand: "read", archiveListCommand: "list" }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "read" ? mocks.read : mocks.list),
}));
vi.mock("@t3tools/client-runtime/connection", () => ({
  FoundryArchive: {
    applyArchivePage: (_projection: unknown, cursor: number) => ({
      projection: null,
      cursor: cursor + 1,
    }),
  },
}));
vi.mock("../components/chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
vi.mock("../components/files/AttachmentFilePreview", () => ({ AttachmentFilePreview: () => null }));
vi.mock("../components/chat/ExpandedImageDialog", () => ({
  ExpandedImageDialogHost: () => null,
  openExpandedImagePreview: vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({ useRenderedAppearance: () => "light" }));

it("bounds automatic archive reads and lets a failed linked archive retry directly", async () => {
  mocks.read.mockReset();
  mocks.list.mockReset();
  const owner = { environmentId: EnvironmentId.make("worker"), threadId: ThreadId.make("thread") };
  const page = (after: number) =>
    AsyncResult.success({
      owner,
      complete: true,
      confirmedCursor: 1000,
      sourceHead: 1000,
      missingArtifacts: [],
      missingAttachmentCount: 0,
      events: [{ sequence: after + 1 }],
      nextCursor: after + 1,
    });
  mocks.read.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Offline"))));
  await using screen = await render(<ThreadArchiveLibrary initialOwner={owner} />);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("could not be read"));
  mocks.read.mockImplementation(({ after }: { after: number }) => Promise.resolve(page(after)));
  await screen.getByRole("button", { name: "Retry linked archive" }).click();
  await expect
    .element(screen.getByRole("button", { name: "More confirmed history" }))
    .toBeEnabled();
  expect(mocks.read).toHaveBeenCalledTimes(5);
  await screen.getByRole("button", { name: "More confirmed history" }).click();
  await expect
    .element(screen.getByRole("button", { name: "More confirmed history" }))
    .toBeEnabled();
  expect(mocks.read).toHaveBeenCalledTimes(9);
});
