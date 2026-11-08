import type { FoundrySandboxState } from "@t3tools/contracts";

const transitions: Readonly<Record<FoundrySandboxState, ReadonlyArray<FoundrySandboxState>>> = {
  requested: ["provisioning", "draining", "failed"],
  provisioning: ["setup", "draining", "failed"],
  setup: ["ready", "draining", "failed"],
  ready: ["draining", "failed"],
  draining: ["stopped", "failed"],
  stopped: ["archiving"],
  archiving: ["deleting", "failed"],
  deleting: ["deleted", "failed"],
  deleted: [],
  failed: ["provisioning", "draining", "archiving"],
};
export const canTransition = (from: FoundrySandboxState, to: FoundrySandboxState) =>
  transitions[from].includes(to);
export const reservesCapacity = (state: FoundrySandboxState) => state !== "deleted";
