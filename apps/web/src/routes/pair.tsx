import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { factoryReturnPath } from "../foundry/home";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";

export const Route = createFileRoute("/pair")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: factoryReturnPath(search.returnTo),
  }),
  beforeLoad: async ({ context, search }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      throw redirect({ href: search.returnTo ?? "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();
  const { returnTo } = Route.useSearch();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the connection so WebSocket and cached scopes use the new pairing cookie.
        router.history.replace(returnTo ?? "/");
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
