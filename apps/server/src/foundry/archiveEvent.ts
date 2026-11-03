import { type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { archiveToolResources, ARCHIVE_UNAVAILABLE_RESOURCE } from "./archiveResources.ts";

export function archiveEvent(event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent {
  if ("worktreePath" in event.payload) {
    const { opens: _opens, ...payload } = event.payload;
    return { ...event, payload: { ...payload, worktreePath: null } } as OrchestrationV2DomainEvent;
  }
  if (event.type === "turn-item.updated" && event.payload.type === "dynamic_tool") {
    return {
      ...event,
      payload: {
        ...event.payload,
        ...(event.payload.viewedImagePath === undefined
          ? {}
          : { viewedImagePath: ARCHIVE_UNAVAILABLE_RESOURCE }),
        ...(event.payload.output === undefined
          ? {}
          : { output: archiveToolResources(event.payload.output) }),
      },
    };
  }
  switch (event.type) {
    case "run.created":
    case "run.updated": {
      const { workspacePreparation: _workspace, ...payload } = event.payload;
      return { ...event, payload };
    }
    case "checkpoint-scope.created":
      return { ...event, payload: { ...event.payload, cwd: "[archived workspace]" } };
    case "provider-session.attached":
    case "provider-session.updated":
      return { ...event, payload: { ...event.payload, cwd: "[archived workspace]" } };
    default:
      return event;
  }
}
