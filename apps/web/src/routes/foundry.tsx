import { createFileRoute } from "@tanstack/react-router";
import { FoundryPage } from "../foundry/FoundryPage";
import { validateFoundrySearch } from "../foundry/workspaceSearch";

export const Route = createFileRoute("/foundry")({
  component: FoundryPage,
  validateSearch: validateFoundrySearch,
});
