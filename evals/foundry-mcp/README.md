# Foundry MCP

N06/F34 acceptance controls: discover allowed factories before selecting a configured swarm,
reuse a pending work command after uncertain delivery, and read the current control revision
before pausing. Imports shipped tool descriptions and schemas directly from the server.

Run `node foundry-mcp/run.ts --out runs/foundry-check` from `evals/`. Uses the existing
local CLIProxyAPI configuration (`shared/proxy.ts`), GPT-6.1 Sol with medium reasoning,
and three inference calls without shell tools or real Factory operations. Proxy usage charges
apply. Results contain synthetic arguments only. Repeat for sampling; these cases establish
next-call selection, not a full execution or public Access acceptance.
