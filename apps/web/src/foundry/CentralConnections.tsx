import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SandboxProviderConnection } from "../components/foundry/SandboxProviderConnection";
import { FoundryUI } from "./FoundryUI";

export function CentralConnections({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <FoundryUI.Panel aria-label="Central connections">
      <FoundryUI.Heading>Central connections</FoundryUI.Heading>
      <SandboxProviderConnection key={environmentId} environmentId={environmentId} />
      <p className="text-sm text-muted-foreground">
        Central access currently supports managed Codex on Linux sandbox workers. Persistent workers
        use their separately configured provider accounts. Other providers do not inherit this
        connection. Worker readiness and capacity are checked separately below.
      </p>
      <details>
        <FoundryUI.Summary>Source control and MCP access</FoundryUI.Summary>
        <div className="space-y-3 pt-3 text-sm text-muted-foreground">
          <p>
            GitHub access uses the configured GitHub App and each Factory’s repository and
            definition source authorization. MCP tools and secret references use each Factory’s
            explicit MCP bindings. A Codex sign-in grants neither GitHub nor MCP access.
          </p>
          <Link
            to="/foundry"
            search={{ view: "factories" }}
            className="underline underline-offset-4"
          >
            Choose a Factory to manage its source and MCP bindings
          </Link>
        </div>
      </details>
    </FoundryUI.Panel>
  );
}
