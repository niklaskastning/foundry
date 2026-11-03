import { describe, expect, it } from "@effect/vitest";
import { EventId, FoundryArchiveError, type FoundryArchiveEvent } from "@t3tools/contracts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { applyArchivePage } from "./foundryArchive.ts";

const created: FoundryArchiveEvent = {
  sequence: 1,
  sourceSequence: 7,
  event: {
    id: EventId.make("created"),
    type: "thread.created",
    threadId: v2ThreadId,
    occurredAt: v2Now,
    payload: v2Projection.thread,
  },
};
describe("Foundry archive projection", () => {
  it("resumes paginated confirmed events and rejects gaps without changing the previous projection", () => {
    const first = applyArchivePage(null, 0, [created]);
    const updated: FoundryArchiveEvent = {
      sequence: 2,
      sourceSequence: 12,
      event: {
        id: EventId.make("title"),
        threadId: v2ThreadId,
        type: "thread.metadata-updated",
        occurredAt: v2Now,
        payload: { ...v2Projection.thread, title: "Archived title" },
      },
    };
    expect(
      applyArchivePage(first.projection, first.cursor, [updated]).projection?.thread.title,
    ).toBe("Archived title");
    expect(() =>
      applyArchivePage(first.projection, first.cursor, [{ ...updated, sequence: 3 }]),
    ).toThrow(FoundryArchiveError);
    expect(first.projection?.thread.title).toBe(v2Projection.thread.title);
    expect(() => applyArchivePage(null, 0, [updated])).toThrow(FoundryArchiveError);
  });
});
