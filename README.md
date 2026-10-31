# Foundry

A permanent fork of [T3 Code](https://github.com/pingdotgg/t3code), preparing a platform for automated software development. T3 supplies the agent runtime and shared Web/desktop interface; the planned Automation layer coordinates workflows, repositories, and execution machines.

**Status: isolated base deployment.** Foundry has Linux container/Compose and Windows x64 build entry points, separate product/data identities, and manual updates. The integrated instance gateway, device registry, Automation engine, and sandbox provisioning remain planned. Official T3 installers and `npx t3` install upstream, not Foundry.

The Linux VPS origin is `http://127.0.0.1:3783`; the operator routes `foundry.heavenforgeprod.com` through Cloudflare Tunnel and Access. See the [deployment runbook](deploy/fork/README.md) for setup, pairing, limits, and recovery.

## Direction

- Linux Main Node and PostgreSQL on a VPS, deployed with Docker Compose.
- One instance URL for login, devices, and Automation; an integrated Main Node gateway instead of a separate Connect deployment.
- Single user first, with Cloudflare Access; a dedicated Linux host worker executes agents. Clerk and team access are later options.
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

Upstream code, supported providers, and mobile sources remain in place to keep integration manageable. A single PR check runs automatically. Linux/Windows artifact builds are manual; inherited workflows have no automatic triggers. See the deployment runbook for the Actions budget.

This project is independent of T3 Tools. Existing [license](LICENSE) and third-party notices remain applicable. Report fork issues in [this repository](https://github.com/niklaskastning/foundry/issues).
