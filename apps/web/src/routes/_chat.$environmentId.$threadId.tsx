import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
  validateSearch: (search: Record<string, unknown>): { factoryId?: string; runId?: string } => ({
    ...(typeof search.factoryId === "string" ? { factoryId: search.factoryId } : {}),
    ...(typeof search.runId === "string" ? { runId: search.runId } : {}),
  }),
});
