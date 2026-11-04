import { createFileRoute } from "@tanstack/react-router";
import { FoundryPage } from "../foundry/FoundryPage";

type FoundrySearch = { view?: string; factoryId?: string; runId?: string; archiveEnvironmentId?: string; archiveThreadId?: string };
export const Route = createFileRoute("/foundry")({ component: FoundryPage, validateSearch: (search: Record<string, unknown>): FoundrySearch => Object.fromEntries(Object.entries(search).filter(([key,value]) => ["view","factoryId","runId", "workItemId","archiveEnvironmentId","archiveThreadId"].includes(key) && typeof value === "string")) });
