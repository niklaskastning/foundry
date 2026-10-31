# Maintaining Foundry

## Repository boundary

`origin` is `https://github.com/niklaskastning/foundry`; `upstream` is `https://github.com/pingdotgg/t3code.git`. The initial fork base is `79f1fadfc6020b820d541ca4691d2feebb15dd1b`. The [architecture](architecture.md) and [deployment](deployment.md) designs define the single-user instance model with an integrated gateway. Check their source references against the implementation when each stage begins.

The design documents describe the target; the [implementation plan](implementation-plan.md) owns package dependencies and acceptance gates. The isolated base deployment and build procedures are documented in [the deployment runbook](operations.md). Instance authentication, the device gateway, and Automation remain implementation stages; do not provision the superseded separate Connect/Clerk stack. Use the Foundry build entry points to enable the isolated runtime profile; ordinary upstream builds preserve upstream defaults.

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

Only the single-job Foundry PR check runs automatically. Foundry artifact builds are manual; Linux images can optionally be published to the fork's GHCR for a separately triggered VPS update. Inherited workflows have no automatic triggers; reusable upstream definitions retain their repository guards. Keep them disabled in Actions settings, and inspect newly introduced workflows during every upstream integration. See the deployment runbook for limits and artifact retention.

## Inputs before deployment

The target is this Linux x64 VPS at `foundry.heavenforgeprod.com`, behind the operator-managed Cloudflare Tunnel and Access. Native-client Access authentication, machine credentials, a dedicated host worker, and an external backup destination remain to be prepared. Windows x64 is the first packaging target. Keep public deployment configuration separate from secrets. Supply credentials through the environment’s secret channel; never put them in the design documents or PRs.

The first infrastructure acceptance target is Web and Windows desktop discovering the same Main Node and Linux execution environment after signing in to the same runtime-configured instance URL, with device traffic through its Main Node gateway. The application must use PostgreSQL for new central state while retaining isolated local T3 SQLite state. Mobile is not part of this acceptance.

## Documentation ownership

Keep fork-specific guidance under this directory. Architecture owns behavior and constraints, deployment owns topology and trust, the implementation plan owns sequencing and gates, and operations owns working commands. Update the owning document when a decision changes and remove the superseded guidance; do not append a competing plan or copy progress checklists into several files. Link from the repository and deployment-folder READMEs rather than duplicating procedures.

The inherited T3 guides and disabled upstream workflow definitions remain for upstream compatibility; they are not Foundry deployment instructions. Likewise, the existing `fork_connect` database name is retained for planned instance data, not evidence of an active Connect service. Do not rename persisted data or delete runtime resources merely to align terminology.
