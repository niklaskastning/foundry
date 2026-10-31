# T3 Code Factory

A permanent fork of [T3 Code](https://github.com/pingdotgg/t3code), preparing a platform for automated software development. T3 supplies the agent runtime and shared Web/desktop interface; the planned Automation layer coordinates workflows, repositories, and execution machines.

**Status: repository preparation.** Automation, the VPS deployment, and an independent Connect service are not implemented yet. Official T3 installers, releases, and `npx t3` install upstream, not this fork. Current source builds still carry upstream runtime identities and update defaults; do not distribute them as isolated Factory builds yet.

## Direction

- Linux Main Node and PostgreSQL on a VPS, deployed with Docker Compose.
- Own Connect service based on the existing Cloudflare Worker and Clerk integration.
- Web and Windows desktop first; no initial mobile development or distribution.
- Inspectable workflow steps backed by ordinary T3 threads, starting with one reliable issue-to-PR flow.
- Later: reusable agents and skills, multiple repositories/workers, ephemeral sandboxes, and persistent memory.

The agreed designs live in [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md) and [FORK_DEPLOYMENT.md](FORK_DEPLOYMENT.md). They include future work and acceptance criteria, not claims of shipped features.

## Development

Install [Vite+](https://viteplus.dev/guide/), then:

```sh
vp i
vp run dev
```

Use an isolated checkout-local T3 home. Never run against an existing personal T3 database; follow the [development runbook](docs/operations/development.md) and [AGENTS.md](AGENTS.md). Provider installation and authentication are required for real agent turns; Replay is available for development verification.

Each implementation task goes through **branch → commits → PR to this fork**. Run `vp run check:changed` before pushing. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [fork maintenance runbook](docs/operations/fork-maintenance.md).

## Documentation and upstream

[Architecture](docs/internals/overview.md) and [user guides](docs/README.md) document inherited T3 behavior. Their official service and installer references describe upstream unless explicitly marked as fork-specific.

Upstream code, supported providers, and mobile sources remain in place to keep integration manageable. Linux CI and manual Windows tests use GitHub-hosted runners in the fork. Upstream publishing, deployment, previews, mobile workflows, and community moderation are gated to the upstream repository.

This project is independent of T3 Tools. Existing [license](LICENSE) and third-party notices remain applicable. Report fork issues in [this repository](https://github.com/niklaskastning/t3code-factory/issues).
