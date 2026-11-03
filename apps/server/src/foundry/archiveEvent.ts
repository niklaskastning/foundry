import { type OrchestrationV2DomainEvent } from "@t3tools/contracts";

export function archiveEvent(event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent {
  if ("worktreePath" in event.payload) {
    const { opens: _opens, ...payload } = event.payload;
    return { ...event, payload: { ...payload, worktreePath: null } } as OrchestrationV2DomainEvent;
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
