# Foundry deployment

Build and runtime configuration live here. The [operations runbook](../../docs/foundry/operations.md) covers setup, pairing, updates, and recovery. Start with [Foundry development](../../docs/foundry/README.md) for architecture and implementation gates.

The production Docker build requires a full `FOUNDRY_REVISION` already available in this fork. It fetches and checks out that commit rather than using local source edits from the Docker context, then rejects artifacts without clean Git provenance. Use the local development server for uncommitted changes. The final image contains the production package, not the build checkout.
