# Maintaining Foundry

## Repository boundary

`origin` is `https://github.com/niklaskastning/foundry`; `upstream` is `https://github.com/pingdotgg/t3code.git`. The initial fork base is `79f1fadfc6020b820d541ca4691d2feebb15dd1b`. The imported [architecture](../../AUTOMATION_ARCHITECTURE.md) and [deployment](../../FORK_DEPLOYMENT.md) designs were written against `d2d1e4f50e`; references must be checked against the implementation when each stage begins.

The imported designs are the roadmap. The isolated base deployment and build procedures are documented in [the deployment runbook](../../deploy/fork/README.md). Automation and own Connect provisioning remain separate implementation stages. Use the Foundry build entry points to enable the isolated runtime profile; ordinary upstream builds preserve upstream defaults.

## Change and integration workflow

Every implementation request uses a branch, focused commits, and a PR targeting this fork’s `main`. Opening the PR is authorized by default; merging is not. Keep unrelated cleanup and dependency upgrades out of feature PRs. Run `vp run check:changed` before pushing and describe any verification limits in the PR.

For upstream integration:

```sh
git fetch upstream
git switch -c chore/upstream-YYYY-MM-DD origin/main
git merge <reviewed-upstream-sha>
```

Resolve conflicts without rewriting published fork history. Inspect semantic changes to orchestration, persistence, auth, and the future Automation adapter even when the merge is clean. Record the upstream SHA, focused verification, and any migration requirements in the PR. Review every new workflow for deployment targets and credentials before merging it.

## CI and publishing

Only the single-job Foundry PR check runs automatically. Foundry artifact builds are manual and do not publish. Inherited workflows have no automatic triggers; reusable upstream definitions retain their repository guards. Keep them disabled in Actions settings, and inspect newly introduced workflows during every upstream integration. See the deployment runbook for limits and artifact retention.

## Inputs before deployment

The target is this Linux x64 VPS at `foundry.heavenforgeprod.com`, behind the operator-managed Cloudflare Tunnel and Access. Own Connect/Clerk resources and an external backup destination remain to be configured. Windows x64 is the first packaging target. Keep public deployment configuration separate from secrets. Supply credentials through the environment’s secret channel; never put them in the design documents or PRs.

The first infrastructure acceptance target is Web and Windows desktop discovering the same Main Node and Linux execution environment through the fork’s own Connect. The application must use PostgreSQL for new central state while retaining isolated local T3 SQLite state. Mobile is not part of this acceptance.
