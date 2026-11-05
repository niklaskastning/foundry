import { createFileRoute, redirect } from "@tanstack/react-router";
import { requiresFactoryPairing } from "../foundry/pageMode";
import { initialState } from "../foundry/onboarding";
import { FoundryPage } from "../foundry/FoundryPage";
import { validateFoundrySearch } from "../foundry/workspaceSearch";

export const Route = createFileRoute("/foundry")({
  beforeLoad: ({ context, location, search }) => {
    if (requiresFactoryPairing(search.view, initialState(), context.authGateState.status)) {
      throw redirect({ to: "/pair", search: { returnTo: location.href }, replace: true });
    }
  },
  component: FoundryPage,
  validateSearch: validateFoundrySearch,
});
