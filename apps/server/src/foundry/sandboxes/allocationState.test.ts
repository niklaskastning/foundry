import { describe, expect, it } from "@effect/vitest";
import { canTransition, reservesCapacity } from "./allocationState.ts";

describe("allocation lifecycle", () => {
  it("retains capacity until stopped deletion and never skips archive confirmation", () => {
    expect(reservesCapacity("failed")).toBe(true);
    expect(reservesCapacity("stopped")).toBe(true);
    expect(reservesCapacity("deleted")).toBe(false);
    expect(canTransition("ready", "deleted")).toBe(false);
    expect(canTransition("archiving", "deleting")).toBe(true);
    expect(canTransition("failed", "deleting")).toBe(false);
    expect(canTransition("deleted", "provisioning")).toBe(false);
    expect(canTransition("setup", "draining")).toBe(true);
    expect(canTransition("failed", "provisioning")).toBe(true);
  });
});
