import { useNavigate, useSearch } from "@tanstack/react-router";
import type { FoundrySearch } from "./workspaceSearch";

export function useWorkspaceNavigation() {
  const search = useSearch({ from: "/foundry" });
  const navigate = useNavigate({ from: "/foundry" });
  function update(patch: Partial<FoundrySearch>) {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  }
  return { search, update };
}
