# Maintaining T3 Code Factory

## Repository boundary

`origin` is `https://github.com/niklaskastning/t3code-factory`; `upstream` is `https://github.com/pingdotgg/t3code.git`. The initial fork base is `79f1fadfc6020b820d541ca4691d2feebb15dd1b`. The imported [architecture](../../AUTOMATION_ARCHITECTURE.md) and [deployment](../../FORK_DEPLOYMENT.md) designs were written against `d2d1e4f50e`; references must be checked against the implementation when each stage begins.

The foundation PR transfers those designs and prepares repository policy and CI. It does not provision infrastructure or provide distributable Factory binaries. Product IDs, data paths, update feeds, telemetry, the Linux container/Compose deployment, Windows packaging, and operator-owned Connect configuration still belong to D0/D1/D2 in the deployment plan. Do not publish inherited builds before those boundaries are implemented and tested.

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

The existing CI remains the quality gate. Linux jobs use GitHub-hosted Ubuntu runners in this fork; manual Windows tests use GitHub-hosted Windows. Native mobile analysis is disabled through the change gate, so the final `Check` job still verifies all required jobs. Shared TypeScript checks may still cover inherited mobile code. Longer CI timeouts accommodate the smaller Linux runners.

Other inherited workflows are guarded with the exact upstream repository identity, including reusable build jobs, release/preview deployments, mobile automation, and upstream moderation. Files remain in their upstream locations to make future merges reviewable. Adding secrets or labels does not enable those jobs in this fork. The private upstream task cache already has its own repository guard.

Own Linux/Windows build and deployment workflows should be added with explicit destinations once isolated builds exist. Do not remove upstream guards globally. Never use upstream npm names, update feeds, cloud accounts, signing credentials, or production data for fork releases.

## Inputs before deployment

D0 still needs the real domain/subdomains, VPS architecture and capacity, Cloudflare resources, a Clerk instance, Windows architecture, and an external backup destination. Keep public deployment configuration separate from secrets. Supply credentials through the environment’s secret channel; never put them in the design documents or PRs.

The first infrastructure acceptance target is Web and Windows desktop discovering the same Main Node and Linux execution environment through the fork’s own Connect. The application must use PostgreSQL for new central state while retaining isolated local T3 SQLite state. Mobile is not part of this acceptance.
