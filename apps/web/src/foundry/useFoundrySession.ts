import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { executeInstanceOperation, initialState, type OnboardingResult } from "./onboarding";

export function useFoundrySession(): readonly [
  OnboardingResult,
  Dispatch<SetStateAction<OnboardingResult>>,
] {
  const [state, setState] = useState(initialState);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the UI synchronized with the shared server session and renew it while this client is active.
  useEffect(() => {
    let disposed = false;
    const changed = () => {
      if (!disposed) setState(initialState());
    };
    const check = () => {
      if (document.visibilityState === "hidden") return;
      void executeInstanceOperation({ operation: "session" })
        .then(changed)
        .catch(() => {
          if (!disposed) setState({ ...initialState(), session: null });
          return executeInstanceOperation({ operation: "inspect" })
            .then(changed)
            .catch(() => undefined);
        });
    };
    window.addEventListener("foundry:session", changed);
    window.addEventListener("focus", check);
    window.addEventListener("storage", check);
    document.addEventListener("visibilitychange", check);
    const interval = window.setInterval(check, 30_000);
    if (!initialState().binding)
      void executeInstanceOperation({ operation: "inspect" })
        .then((result) => {
          if (!disposed && result.binding)
            return executeInstanceOperation({ operation: "confirm", candidate: result.binding });
        })
        .then(changed)
        .catch(() => undefined);
    else check();
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("foundry:session", changed);
      window.removeEventListener("focus", check);
      window.removeEventListener("storage", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return [state, setState] as const;
}
