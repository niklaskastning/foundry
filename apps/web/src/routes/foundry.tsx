import { createFileRoute } from "@tanstack/react-router";
import { FoundryPage } from "../foundry/FoundryPage";

export const Route = createFileRoute("/foundry")({ component: FoundryPage });
