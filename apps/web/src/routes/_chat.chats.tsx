import { createFileRoute } from "@tanstack/react-router";
import { IndexDraftLanding } from "./_chat.index";

export const Route = createFileRoute("/_chat/chats")({ component: IndexDraftLanding });
