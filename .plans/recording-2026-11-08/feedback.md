# Foundry: issues and product topics from the 8 November 2026 recording

## Source, evidence and scope

- Recording: `C:\Users\nikla\development\foundry\Bildschirmaufnahme 2026-11-08 141857.mp4`.
- Duration: **27:32.8**. German narration; Windows browser; application at `https://foundry.heavenforgeprod.com`. The deployed commit is not established by the recording. Acceptance/test factories and historical runs are visible.
- This is a handoff of the maintainer's feedback, not an implementation report or a claim that every suspected bug has been reproduced. No app behavior was changed or runtime-tested for this extraction.
- Audio was transcribed locally and interpreted alongside timestamped screen captures. The descriptions are English paraphrases, not exact quotations. Automatic transcription can misrecognize technical terms; visible UI labels were used where available. Times below are approximate locations from the beginning of the recording.
- **Problem** means a reported problem, **request** means desired behavior, and **exploratory** means a proposed direction with unresolved details. Acceptance suggestions are the extracting agent's interpretation, not additional statements made by the maintainer.
- Screenshots are in the separate `screenshots/` folder. They preserve application content at source resolution and omit browser chrome/bookmarks. They illustrate the recorded state, not before/after proof of a fix. Relative links keep this folder portable.
- Keep the MP4 local and out of Git. This Markdown and its screenshots are local, ignored work artifacts under `.plans/`; no commit or PR was created.

## Overall intended product model

Foundry should be one application with central login, a unified inventory of machines, centrally configured provider access, and product-specific Factories driven by a definitions repository. Factories own their work, execution history, definitions and reporting. Chats are the interactive workspace for work the user starts or explicitly takes over. Internal configuration and IDs should not overwhelm task and result views.

**Follow-up clarification: Foundry will not have a Foreman.** Warp's Foreman in the later reference diagram is explicitly excluded; workflow execution remains service-orchestrated. Foundry MCP should make capabilities available to chat/coding agents, including feature planning and starting swarms (F33–F34).

The narrator references Warp (`warp.dev`) for Factory organization/reporting and T3 Code for interactive chat, diffs and question/answer interactions. These are design references, not a requirement to reproduce every behavior. Some proposed menu names and metrics are examples rather than final specifications.

## Entry, identity, machines and settings

### F01 — Show login immediately when there is no active session

**00:00–00:35 · Problem/request.** The recording starts on the Factories surface without an active Foundry session. The user expects sign-in immediately on opening the site and says no application surface should be accessible before signing in.

Visible navigation is not proof that protected server data or APIs are unauthenticated. Investigate client entry/routing and server authorization separately.

**Acceptance suggestion:** fresh and expired sessions, including protected deep links, lead to login; successful login returns to the intended destination; protected data remains guarded.

Evidence: [00:00 initial workspace](screenshots/00-00-initial-workspace.png).

### F02 — Simplify browser login and separate desktop instance selection

**00:35–01:15 · Problem; partly exploratory placement.** Asking for an Instance URL in a browser already on that origin is unnecessary. The narrator thinks this input belongs primarily on desktop, where an instance must be chosen. Verified instance identity is useful for debugging, but should not dominate normal login. Session controls also feel misplaced here; the suggestion that they belong on desktop is tentative.

**Acceptance suggestion:** browser login uses its current origin with a clear sign-in action; desktop retains instance selection; useful diagnostic/recovery controls remain accessible without overwhelming normal entry.

Evidence: [00:45 instance sign-in](screenshots/00-45-instance-sign-in.png).

### F03 — Central login should immediately expose chats and authorized machines

**01:15–02:45 · Problem/request.** After Foundry sign-in, Chats still does not show the expected conversations. The user has to find **Open device** in connection settings first. Chats and machine access should be bound to the central login rather than requiring this extra activation step.

The intended model is a unified view of all connected devices/environments, not manually opening each device. Example: ten VPSs may host interactive chats and also provide Factory/sandbox execution. Show them in a common inventory with their applicable roles and state.

**Acceptance suggestion:** after central sign-in, authorized machines and conversations are discoverable without manual per-device opening/pairing; offline machines are intelligible; execution authorization and interactive access remain correctly enforced.

Evidence: [02:10 device settings and Open device](screenshots/02-10-device-settings.png).

### F04 — Adapt Settings to Foundry instead of retaining an undifferentiated T3 copy

**02:40–04:10; 06:10–08:30 · Problem/request.** Settings needs a logical division between Factory/platform functionality and chat functionality. Projects, Source control and existing agent-related settings may still be needed for interactive chat. The user is asking for a coherent organization, not deletion of all inherited settings.

Resources and connection/device setup overlap. A possible structure is expandable global Settings in the main sidebar, with Resources, Providers and other suitable subpages directly below it. Determine ownership of each setting rather than exposing duplicate setup surfaces.

**Acceptance suggestion:** users can tell whether a setting is global, per Factory, per machine, or for an interactive project, and find one authoritative configuration path.

Evidence: [02:10 inherited settings navigation](screenshots/02-10-device-settings.png), [08:00 Resources](screenshots/08-00-resources.png).

### F05 — Configure provider access centrally for workers and sandboxes

**03:08–03:45; provider screens recur around 07:00 · Request.** The user wants one central place to register/authenticate providers and make that access usable on relevant devices and newly spawned sandboxes. Repeating CLI login on every VPS is the pain point.

Later, Settings is scoped to Foundry Main and shows unavailable providers. This provides context, but does not establish that the execution worker's provider is broken. Main versus worker responsibility matters.

**Acceptance suggestion:** central setup results in usable provider access on an authorized worker/sandbox, with clear readiness and revocation. The recording does not prescribe indiscriminate copying of credential files; select a concrete credential-distribution/authorization design.

Evidence: [03:40 provider settings](screenshots/03-40-provider-settings.png), [07:10 provider status on Main](screenshots/07-10-main-provider-status.png).

### F06 — Use an account/profile control instead of a normal link back to login

**04:10–05:10 · Request.** Chats and Settings at the bottom of the sidebar are good. **Instance & sign-in** should instead behave like an account/profile affordance. A click could open a small menu/popover with profile, logout and related account operations. An already signed-in user's ordinary account interaction should not just open the central login screen.

Evidence: [04:40 sidebar bottom entries](screenshots/04-40-factory-list.png).

### F07 — Sessions expire too quickly during active use

**18:15–18:35 · Reported problem.** The narrator says they have already been logged out again during the walkthrough and that the session duration is much too short.

The recording does not establish which layer expired: Foundry, T3, Access, token refresh, or client state. Diagnose the actual cause before changing lifetimes.

**Acceptance suggestion:** active use survives the intended session duration and refreshes correctly; actual expiry leads to a recoverable login flow. Cover central-login and chat/machine-session interaction.

## Factory navigation and definitions ownership

### F08 — Put expandable Factories in the main sidebar

**05:08–06:15; 07:10–08:40; 10:05–10:40 · Request.** Replace the dominant global Factories / Work / Decisions / Runs hierarchy with actual Factories from the definitions repository. Examples include a software Factory, an ERP product and another automation.

Each Factory should expand/collapse to its own pages. Suggested sections include Work/work items, Runs, Evaluations, Definitions (agent and workflow definitions), and possibly PRs. Exact names remain open. The existing Factory tabs broadly represent useful subpages; move that context into the sidebar instead of making users repeatedly select a Factory in global views.

The sidebar should scroll with many Factories. Factories should have icons, potentially through an icon path in their definitions. Child pages preferably remain plain text without an icon for every child. Keep global Chats and Settings near the bottom.

**Acceptance suggestion:** Factory context remains explicit through navigation; collapse/expand and overflow work with many Factories; Factory pages do not redundantly ask which Factory the user meant.

Evidence: [10:50 current Factory tabs](screenshots/10-50-factory-overview.png).

### F09 — Chats should contain interactive work, not every automation thread

**08:10–08:45 · Request.** Show chats the user started interactively and runs they explicitly took over into interactive work. Do not flood Chats with every underlying automation thread. Factory execution history must remain reachable in its Factory/run context.

**Acceptance suggestion:** automated-only threads stay in execution context; user-created and explicitly taken-over threads appear in Chats; links preserve the originating work/run.

### F10 — Improve the Factory index and list click targets

**09:05–10:10; repeated around 13:58–14:10 · Problem/request.** The current Factory index adds little value. Only **Open workspace** is clickable rather than the entire row. The narrow click target also recurs for work/run rows. “Needs your attention” may be unnecessary on the Factory index.

The narrator initially suggests making Create Factory a prominent action instead of an expandable section, then corrects the model: Factory creation belongs in the definitions repository, so a separate local creation UI may not belong here at all. Do not implement both thoughts as simultaneous requirements.

**Acceptance suggestion:** rows navigate naturally while preserving secondary actions; the index serves selection/overview; Factory creation respects the definitions owner.

Evidence: [04:40 Factory index](screenshots/04-40-factory-list.png), [16:00 work-item run row](screenshots/16-00-work-item.png).

### F11 — Configure the definitions repository and selectable revision centrally

**09:55–10:20 · Request.** Add an appropriate Settings section for the Foundry definitions repository. Default to the newest state of `main`, but permit another branch or an earlier commit to try different definitions.

**Acceptance suggestion:** source and effective branch/commit are visible; alternate definitions can deliberately be tested. Do not interpret the default as permission to mutate definitions pinned to an existing run or bypass explicit activation.

### F12 — Link roles, skills and workflows to their rendered and Git definitions

**16:29–17:36 · Request.** Agents & skills should link to the relevant definition rendered in Foundry and to its Git/GitHub source. The user wants to inspect both source and interpretation. A workflow labelled only `main` should use a meaningful human-readable name from the definitions repository.

**Acceptance suggestion:** effective roles/skills/workflows lead to the correct source and rendered definition; revision is clear; friendly names do not replace stable internal identity.

Evidence: [17:20 workflow named main](screenshots/17-20-workflow.png).

### F13 — Triggers should be read-only reflections of Git-owned configuration

**17:36–18:13 · Explicit request.** Manage triggers in the definitions repository. Display them in Foundry rather than maintaining an independent editable trigger configuration. The Definition page itself is broadly acceptable; moving Factory subpages into the sidebar still applies.

**Acceptance suggestion:** users can inspect trigger configuration and source; mutation paths do not create a competing owner.

## Factory overview, work and execution

### F14 — Give each Factory a dashboard with meaningful metrics and activity

**10:35–13:30 · Request with exploratory metrics.** Overview is a reasonable Factory landing page, including attention and open work. Show current state at a glance with charts/visualizations. Add per-Factory activity visibility.

Proposed metrics/topics:

- Cost per work item and per PR, with trends over time.
- Time from new work item to PR, human approval and merge; cycle time.
- Agent/automation activity and outcomes.
- Cost split into compute, platform and inference. The narrator questions whether platform costs apply; the exact accounting model is unresolved.
- Rework required by a PR/run: human-requested changes and human edits. A tentative proxy is code accepted unchanged versus code later changed by humans or at their instruction. This is not a validated quality metric or a settled implementation formula.

**Acceptance suggestion:** define metric semantics, provenance and available data before presenting numbers; show missing data honestly; link metrics back to underlying work/runs.

Evidence: [10:50 current Factory Overview](screenshots/10-50-factory-overview.png).

### F15 — Work-item detail needs an input → execution → result story

**13:58–16:30 · Problem/request.** The page is overloaded with text, technical setup and controls; the user cannot tell where to start. Primary questions are: what is the task, what input came from its source/provider, what did we do, and what changed?

Wanted context includes T3-style diffs, related PRs, GitHub comments and the sequence of runs/attempts. A run list is useful. The local state filter may be unnecessary. Secondary details could be collapsed or contextually revealed; hover is one suggestion, not a mandate to hide essential information behind hover.

**Acceptance suggestion:** input, latest outcome, change/PR and relevant history are apparent without traversing operational setup; technical evidence remains accessible.

Evidence: [16:00 work-item detail](screenshots/16-00-work-item.png), [14:40 expanded setup](screenshots/14-40-start-work-settings.png).

### F16 — Starting a workflow should be a focused action

**14:50–16:00 · Problem/request.** Prefer an action such as **Start new workflow** that opens a focused flow, rather than a large inline Start work form. Too many inputs are exposed. `Input revision` is particularly internal and unhelpful to the normal user. **Authorize and start workflow** and **Save repository defaults** do not make their meaning clear.

Worker/project/model defaults still need to work, but should not obscure the task. This is not a request to discard authorization or revision tracking.

**Acceptance suggestion:** configured defaults support a simple start flow; advanced operational settings are available as needed; labels explain what the action changes.

Evidence: [14:40 start-work settings](screenshots/14-40-start-work-settings.png).

### F17 — Make interactive takeover obvious and show its history coherently

**15:50–16:30 · Problem/request.** Interactive work means opening the run's code/state in T3 Code to make changes, then accessing that work through Chats. Give it a clear action. Burying it at the bottom of the long work-item form is confusing. An overview/history of interactive work may still be useful, but should be cleanly presented and linked to the run.

**Acceptance suggestion:** takeover opens the correct run state/thread, preserves origin links, and makes subsequent interactive changes understandable.

### F18 — Run detail should explain execution topology visually

**20:28–21:25 · Problem/request.** Run information is broadly useful but still too text-heavy to understand at a glance. The distinction between workflow progress and execution history is unclear. Show which device/VPS executed the work and, when applicable, which sandbox on that machine.

**Acceptance suggestion:** users can identify current step, meaningful history, execution machine and sandbox without reconstructing relationships from text. Preserve historical execution identity when a machine disappears.

Evidence: [20:40 workflow progress and execution history](screenshots/20-40-run-detail.png).

### F19 — Back to Runs loses the global navigation context

**Approximately 21:05–21:30 · Reported navigation bug.** After opening a run from the overall Runs view, **Back to Runs** returns to a Factory-specific view instead of the all-Factories Runs list the user came from.

**Acceptance suggestion:** back navigation respects the entry context, including global versus Factory views and applicable filters; direct links have a sensible fallback. Runs and Decisions may also belong in a shared global activity feed (see F21).

Evidence for the global entry context: [21:40 all-Factories Runs](screenshots/21-40-runs.png). The still image alone cannot prove the back-navigation sequence; use the source interval to reproduce it.

## Decisions and activities

### F20 — Decisions must contain a clear question and a usable answer interaction

**18:35–19:30 · Problem/request.** Present the actual question posed by the agent, with clear answer choices and/or free text. The relevant workflow/step waits while the user answers. Reuse the existing T3 Code question interaction where appropriate. Long operator/test instructions in the current detail do not communicate an ordinary answerable question well.

**Acceptance suggestion:** the question, options, context and consequences are explicit; the answer goes to the exact pending step/attempt and resumes the appropriate execution when allowed.

Evidence: [19:00 current decision detail](screenshots/19-00-decision-detail.png).

### F21 — Integrate Decisions with activity and distinguish answering from organizing

**19:25–20:28; 21:10–21:30 · Request/exploratory navigation.** A global cross-Factory activity feed could contain outstanding Decisions and Runs. Users would open questions from a list and answer them. The current list-left/detail-right layout is questioned, not categorically rejected.

Read/unread is reasonable. Answering should automatically mark a decision done. Marking done without answering should instead be an explicit operation such as closing a decision or cancelling a workflow when it is wrong. The important problem is that personal inbox organization must not masquerade as resolving a pending question.

**Acceptance suggestion:** distinguish unread, personally organized, answered/resolved, superseded and cancelled. Define any new close/cancel operation's workflow effect; never silently treat inbox organization as approval.

Evidence: [19:00 decision list/detail](screenshots/19-00-decision-detail.png), [20:20 actions](screenshots/20-20-decision-actions.png).

## Evaluations, external collaboration and planning

### F22 — Evaluate past runs and improve the definitions repository

**13:00–13:58; 21:35–23:20 · Request with exploratory reporting.** Provide Evaluations and evaluation agents/workflows that inspect historical threads and runs, determine what succeeded or failed and why, account for cost, and propose improvements in the definitions repository.

The later clarification is important: evaluation agents may need to be defined **outside individual Factories**, because they operate across Factories. Surface their results and scoring in the app. A cost-versus-efficiency/success visualization is proposed, but axes and scoring semantics are not settled. Do not implement an arbitrary score as an agreed metric.

The narrator briefly suggests Factory settings, then corrects that definitions configuration belongs in the repository. Preserve that single ownership model.

**Acceptance suggestion:** evaluations reference their evidence and evaluated revisions, produce interpretable outcomes and traceable proposed changes, and do not silently modify historical runs or activate new definitions.

### F23 — Report Factory progress back to GitHub issues and PRs

**23:25–24:25 · Request.** A label/tag on an issue can select work for a Factory and trigger a workflow. While it runs, add useful comments to the source issue/PR: acknowledged/understood, started, progress and outcome. External participants should understand what happened without opening Foundry.

The output/comment format should be flexible enough for agents to choose appropriate content within configured behavior. The user does not specify rigid templates or an exact cadence. Apply the same principle to PRs and relevant comment threads.

**Acceptance suggestion:** execution is linked to the originating issue/PR; lifecycle updates are useful and attributable; retries do not generate duplicate starts or uncontrolled comment spam.

### F24 — Start workflows from GitHub mentions/comments, not only labels

**24:20–25:00 · Request.** Mention/tag the Foundry GitHub app, or use an explicit command resembling `@foundry`, in an issue/PR comment to start a workflow without adding a label. The exact syntax is an example, not finalized.

**Acceptance suggestion:** eligible comments route to the correct Factory and workflow with source context, permission checks and deduplication; generated comments cannot recursively trigger uncontrolled work.

### F25 — Let a workflow classify a request and start the appropriate other workflow

**24:50–25:30 · Request.** A dispatcher triggered by an issue/PR comment should decide which workflow fits: reviewing a PR, fixing it, extending an issue, creating a new issue, or another appropriate path. This is explicitly a request for workflows that can initiate other workflows.

**Acceptance suggestion:** routing is observable and preserves source context, parent/child relationships and scope; retries do not duplicate child runs. Decide bounded routing and failure semantics rather than introducing an unlimited recursive dispatcher.

### F26 — Agents should be able to create GitHub issues

**25:20–25:55 · Request.** Workflows/agents should sometimes create new issues so identified work can become independently triggerable work. This also supports the planning use case below.

**Acceptance suggestion:** created issues have meaningful source/plan links and appropriate Factory/trigger metadata; issue creation does not accidentally create unbounded self-triggering work.

### F27 — Plan features in chat, persist the plan visibly, then launch multiple workflows

**25:40–27:00 · Request.** Start a chat for an existing Factory, understood as a collection of repositories, to plan and eventually implement a feature. The chat agent should be able to connect to Foundry capabilities, create issues and/or a plan artifact visible in the app, and show the plan's current state.

The example is a plan with roughly ten items, each starting an appropriate implementation workflow. Include dependencies between items, scheduling/order and the workflow assigned to each. This is coordinated multi-item planning and implementation, not merely a chat answer containing a checklist. The exact tool/API for connecting the chat agent is not unambiguously specified by the audio.

**Acceptance suggestion:** a durable plan has visible items, dependency/state tracking and linked issues/runs; bulk execution is deliberate and failures/retries preserve plan identity and dependencies.

### F28 — An overseer should coordinate outcomes, integration and final testing

**26:45–27:32 · Request/exploratory design.** An overseer agent checks completed workflow results against the overall plan, decides whether the outcome fits, may integrate different branches, and may launch final testing or other concluding workflows.

This is a product request, not authorization from this recording for automatic merging or production deployment. Integration ownership, conflicts, final success criteria and human gates remain to be designed.

**Acceptance suggestion:** cross-run integration has a known owner, traceable inputs and a tested final revision; failed/conflicting child results are handled explicitly; applicable human approval boundaries remain intact.

## Additional maintainer feedback after the recording

### F29 — Define execution runners per Factory in the definitions repository

**Source: explicit follow-up request and attached reference image, 8 November 2026; no recording timestamp. Request.** The definitions repository must also support defining the runners on which agents execute. These definitions belong **inside each Factory's directory**, so runner configuration is owned and versioned per Factory rather than existing only as global machine configuration.

The supplied reference shows a Factory directory containing `factory.yaml` and sibling directories such as `agents/`, `automations/`, `runners/` and `skills/`. The selected example is `runners/standard.yaml`. It illustrates the following runner configuration:

```yaml
description: Warp-hosted Linux runner for standard agent work.
instanceShape:
  vcpus: 2
  memoryGb: 4
platform:
  os: linux
  arch: x86_64
  linux:
    dockerImage: node:22-bookworm
setupCommands:
  - "export PAGER=cat"
  - "corepack install"
```

The firm requirement is Factory-local runner definitions used for agent execution. The image supplies context for resource requirements, platform/architecture, a container image and setup commands; its Warp hosting text, exact schema, numeric sizes, image and commands are reference examples, not separately confirmed Foundry defaults.

**Acceptance suggestion:** a Factory can version its runner profiles in its own `runners/` directory; agents/workflows can select the appropriate profile; execution resolves that profile to a compatible authorized worker/sandbox and exposes the effective configuration. Validate invalid or unavailable profiles before execution, and preserve the runner definition revision/configuration with the run. Define how setup commands execute and persist their environment. Keep concrete machine access, credentials and execution authorization in the existing operational binding model.

**Open details:** runner-reference syntax in agent/workflow definitions, default/override precedence, profile-to-worker/sandbox resolution, and supported provisioning backends are not specified by this follow-up. Coordinate with F05 (central provider access), F11–F13 (Git-owned definitions) and F18 (visible execution machine/sandbox).

Reference: [Factory-local runner definition supplied by the maintainer](screenshots/factory-runner-definition-reference.png).

### F30 — Benchmark models on real work and compare quality against cost

**Source: maintainer follow-up reference image, 8 November 2026; inspiration, not recording evidence.** Add model benchmarks grounded in the Factory's own engineering tasks. The supplied Warp reference illustrates a scatter plot with **average cost on the horizontal axis** and **correctness on the vertical axis**, labelled model/configuration points, selectable comparison metrics and a detail card identifying a benchmark winner.

Use this as inspiration for comparing model configurations on representative tasks and finding a useful cost/quality trade-off. Relate results to the evaluation evidence in F22 and cost metrics in F14. Preserve the tested model, reasoning/configuration, task set, definition revision, scoring method and run evidence so comparisons are interpretable and reproducible. A higher-cost or lower-cost point is not inherently the winner; selection needs an explicit quality target/objective.

The image's model names, prices, percentages and claimed cost reduction are illustrative reference content, not verified Foundry measurements, current model recommendations or acceptance thresholds.

**Acceptance suggestion:** users can compare evaluated configurations on a common task set, inspect cost and quality evidence, and understand why a configuration is preferred. Mark missing measurements and differing test conditions clearly.

Reference: [benchmark cost versus correctness](screenshots/benchmark-cost-quality-reference.png).

### F31 — Show evaluations, cross-model benchmarks and improvement loops together

**Source: maintainer follow-up reference image, 8 November 2026; inspiration.** The second reference presents a quality overview with three related areas:

- **Evaluations on your own work:** headline score/pass state, trend over time and recent evaluation results.
- **Benchmarks across models:** relative performance, model comparisons, trends and pass/fail results.
- **Self-improvement loops:** visible improvement deltas, trends and a history of changes such as memory updates, prompt tuning and detected regressions.

Connect evaluation → benchmark/comparison → proposed improvement → re-evaluation. Users should be able to inspect which evidence motivated a change, which definition/prompt/memory revision changed, and whether the next evaluation improved or regressed. This extends F22's cross-Factory evaluation and definitions-improvement loop rather than creating unrelated dashboard scores.

The displayed percentages, normalized multipliers, deltas, model names and `auto-fix` label are examples. Their formulas and any automatic activation policy are not specified or authorized by this image. Improvement claims need comparable measurements; regressions and unsuccessful changes must remain visible.

**Acceptance suggestion:** summary cards link to individual results and change history; metric definitions and baselines are explicit; an improvement can be traced to its before/after evidence and effective revision, with applicable review/activation gates preserved.

Reference: [evaluations, benchmarks and self-improvement overview](screenshots/quality-improvement-loop-reference.png).

### F32 — Combine cost-per-PR trends with a live agent activity overview

**Source: additional maintainer follow-up image, 8 November 2026; inspiration supplied in the ongoing handoff task.** The third reference combines an operational cost view and a compact activity/control-plane view:

- A headline **cost per PR**, change versus a comparison period, and a time-series breakdown into **compute, platform and inference** with category totals.
- An activity list with understandable current states (for example, ready for task, drafting a specification, routed to specification), model/provider or harness labels, agent identifiers and recency.

Use this to clarify F14's dashboard/cost breakdown and F18/F21's execution/activity visibility. Make it easy to relate spending to actual work and see what agents are doing across the relevant Factory scope. Define how costs are attributed to PRs and time periods, particularly for shared infrastructure, retries, failed work and work that never produces a PR. Show whether data is measured, estimated, stale or unavailable.

The reference's amounts, percentage reduction, model labels and statement that no agent is ever idle are illustrative marketing content, not Foundry results or a requirement to keep agents continuously busy. Do not infer a new governance/security feature specification from the heading alone.

**Acceptance suggestion:** the displayed total reconciles with its cost categories and declared attribution method; activity states link to their real work/run/agent, expose recency honestly, and support tracing the execution machine/sandbox where relevant.

Reference: [cost-per-PR and agent activity control plane](screenshots/cost-activity-control-plane-reference.png).

### F33 — Keep the Warp Factory overview as a selective architecture/product reference

**Source: maintainer follow-up image and explicit clarification, 8 November 2026.** The supplied diagram is a **Warp** reference; only selected concepts apply to Foundry. It connects work sources, automations, version-controlled Factory definitions, execution, dashboards, human handoff and measurement/improvement.

Relevant inspiration includes:

- Work entering through external tools, webhooks, an API or Factory MCP.
- Version-controlled definitions for agents, automations, runners, skills and evaluation/scoring behavior.
- Configured execution environments, repositories, models and harnesses per stage.
- Implementation/review/revision loops, PRs with evidence and updates to the original work item.
- Dashboard visibility into work stages, runs, costs and metrics.
- Scoring completed runs, benchmarking configurations and proposing definition changes for recurring failures.

**Explicit maintainer decision: Foundry will not have a Foreman.** Do not introduce Warp's Foreman agent, a mandatory parent conversation per work item, or a central supervising agent as the execution/routing architecture. Existing service-based orchestration remains the basis. F25's workflow routing and F28's proposed overseer/integration behavior do not imply a Foreman; any such optional workflow role must be scoped separately and must not become a required parent agent for all work.

Warp-managed hosting, its integration inventory, fixed Triage → Spec → Implement → Review stages, approval placement and the diagram's merge policy are reference-specific, not automatically Foundry requirements. Apply Foundry's own workflow definitions, repository policy and explicit authorization boundaries. This image adds no automatic merge or deployment authorization.

Reference: [Warp Factory architecture and work-item flow](screenshots/warp-factory-overview-reference.png).

### F34 — Expose Foundry capabilities through MCP for planning and coding agents

**Source: explicit maintainer follow-up, 8 November 2026. Request.** A Factory/Foundry MCP interface is useful both for the chat-driven feature planning in F27 and for coding agents that need to interact with Foundry. **Starting a swarm is an explicit example of the desired agent-accessible capability.** This clarifies F27's previously unspecified agent-to-Foundry integration path.

The intended interaction is that a chat or coding agent can work with the relevant Factory context, turn planning into actionable Foundry work, and invoke supported orchestration capabilities rather than requiring the user to reproduce everything in the UI. Coordinate this with F25's child-workflow routing and F27's durable multi-item plans. MCP access does not require or introduce a Foreman.

**Acceptance suggestion:** an authorized external coding/chat agent can discover the relevant Factory/workflow capabilities, submit an appropriate request (including starting a configured swarm), receive durable work/run identifiers and inspect status/results. MCP tools should call the same service methods as other transports, retain caller/Factory scope and source context, and preserve configured permissions, activation/version pinning and human gates. Duplicate requests must not accidentally launch duplicate work.

**Open details:** the concrete MCP tool inventory, authentication, exposure of plan creation versus work-item/workflow operations, swarm configuration/selection, and supported control/cancellation operations remain to be designed. Do not infer that MCP currently supports these operations from this request or the Warp screenshot.

## Main status audit of the seven Factory building blocks — 8 November 2026

**Source: explicit maintainer follow-up; repository audit of local `main` at `dfeb62c511533eef46fb411d22c36c18d7d34b8a`.** This supplements the recording with implementation evidence. It does not establish the deployed revision, repeat runtime acceptance, or verify Warp's current product. The supplied “Warp documented” column is reference context only. Existing tests were inspected, not executed for this audit. Plans are not treated as shipped features.

| Building block                          | Foundry on audited main                                                                                                                                                                                            | Remaining gap / feedback connection                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sequential Factory, Git, Inbox, Handoff | **Present.** Durable runs, versioned Git definitions, GitHub polling/PR publishing, decisions and T3 takeover/return exist.                                                                                        | The usability and collaboration requests F15–F17/F20–F24 still apply; existing capability does not establish acceptance of the recorded behavior.                                                                                                                                                                                                 |
| Factory agents and resources            | **Partially present; the original blanket “central integration missing” is too broad.** V4 has reusable Git-versioned agents, complete pinned skill bundles and explicit Factory-scoped Codex MCP/secret bindings. | Central provider/source-control account setup and distribution, additional provider/OAuth paths and automatic model routing remain open (P14Z/P52; F05/F12). Agent access to external MCP servers is distinct from exposing Foundry itself through MCP (F34).                                                                                     |
| Parallel Factory execution              | **Present for Linux/Codex.** DAG execution, worker pools/capacity, persistent swarms, joins and business review/fix loops exist.                                                                                   | Do not reimplement basic parallelism. Dynamic workflow dispatch, durable multi-workflow planning and optional outcome/integration coordination are separate requests (F25/F27/F28). Further real-machine and native Windows acceptance remains open. No Foreman is requested.                                                                     |
| Runners and sandboxes                   | **Partially present infrastructure; reproducible runner/sandbox product missing.** Persistent host workers, workspace reservation, capacity and central archives exist. A worktree is not a sandbox.               | Factory-local, Git-owned runner definitions and their actual execution binding (F29), versioned profiles, OCI provisioning, setup/enrollment, sandbox credentials, archive/delete/TTL/resume, client controls and workflow lifecycle integration remain open (P34–P40). Sandbox work described as underway in docs is not delivered on this main. |
| Scorers, benchmarks, improvement        | **Missing as Factory product capabilities.** Existing tests, checkpoints, artifacts and review/fix loops do not supply versioned scoring history or comparable benchmark trials.                                   | Deliver run/PR usage attribution and honest cost/quality metrics, versioned scorers with run/history results, reproducible task/configuration trials and evidence-backed definition-improvement proposals with re-evaluation (P54–P57; F14/F22/F30–F32).                                                                                          |
| External Factory access                 | **Partial.** Versioned HTTP API for user sessions plus Factory-scoped machine read credentials with expiry/revocation exist.                                                                                       | Machine-authenticated start/control, Factory MCP for external planning/coding agents (including configured swarm starts), and an accepted public Access/CI path remain open (P58; F34). HTTP availability alone does not establish unattended CI write access.                                                                                    |
| Factory workspace                       | **Beyond basic views.** Factories-first navigation and contextual overview, work, agents/skills/MCP, workflows, definitions, triggers, runs and Inbox views exist after PRs #67/#72/#74.                           | Human design acceptance remains open; preserve the concrete navigation, task/result, decision and reporting feedback (F08–F21). Quality dashboards and scorer/benchmark/improvement pages need the missing product capabilities above. Do not equate existing tabs or automated UI checks with accepted UX or complete Warp parity.               |

### Remaining scope to carry forward

Use the existing feedback items rather than opening duplicate requests: **central connections/resources** (F05/F12), **Factory-owned runners and full sandbox lifecycle** (F29), **metrics/scorers/benchmarks/evidence-backed improvement** (F14/F22/F30–F32), **external Foundry MCP and unattended machine/CI control** (F34), and **workspace usability/design acceptance** (F08–F21). Keep dynamic dispatch and multi-workflow planning (F25/F27/F28) separate from the already shipped static parallel/swarm execution. Native Windows Factory execution/operation and public authentication/access retain their own acceptance gates; mobile remains deferred.

**Code evidence on the audited main** (paths relative to the repository root):

- Core execution and collaboration: `apps/server/src/automation/{Definitions,DefinitionSync,GitHubPolling,Publish,Control,Inbox,Handoffs}.ts`.
- Resources and actual worker boundary: `packages/contracts/src/automation/definitionV4.ts`, `apps/server/src/automation/{McpBindings,executionConfiguration}.ts`, `apps/server/src/foundry/WorkerResources.ts`. The resolved v4 agent execution contract explicitly selects Codex; upstream T3 providers do not establish Factory adapter parity.
- Parallelism: `apps/server/src/automation/{Scheduler,V4Execution}.ts` and their existing tests; `Scheduler.test.ts` asserts two branch launches before their joined successor and checks capacity gating. `V4Execution.test.ts` covers persisted swarm/iteration semantics.
- External access: `apps/server/src/automation/{ApiHttp,MachineAccess,Application}.ts`, `apps/server/src/foundry/MachineCredentials.ts`, `packages/contracts/src/automation/{api,machineCredential}.ts`. HTTP command routes exist, but their existence does not grant machine callers write authorization.
- UI: `apps/web/src/features/automation/{FactoryPage,AgentCatalog,V4Configuration,V4RunProgress,InboxPage,HandoffPanel}.tsx` and `apps/web/src/foundry/FoundrySidebar.tsx`.
- Remaining scope and acceptance boundaries: `docs/foundry/{README,implementation-plan,warp-comparison}.md`, specifically P14Z/P34–P40/P49b/P52/P54–P58. No delivered runner/sandbox lifecycle or Factory scorer/benchmark service was found in the Automation implementation/contracts inspected.

## Repository context for an implementing agent

Read the repository's current `AGENTS.md`, then `docs/foundry/README.md`, `architecture.md`, `deployment.md` and `implementation-plan.md`. Design documents describe planned functionality; use the current implementation and operations runbook to establish what actually ships. This recording is fresh feedback, not proof that earlier implementation or acceptance gates passed.

Relevant existing constraints and boundaries:

- Factories-first is already the product direction. Current documentation identifies P49b as ongoing UI/design work and keeps human design acceptance separate from automated/browser verification. This recording contains further user acceptance feedback.
- Native login, eliminating separate Main-T3 pairing, and central provider/source-control/MCP connections already have open planning context (including P03N and P14Z). F01–F05/F07 should be reconciled with that work instead of producing another independent auth system.
- Definitions are versioned and Git-owned. New source/revision, trigger and evaluation UI must respect explicit activation and immutable run pinning. “Latest main by default” does not alter a running run's configuration.
- PostgreSQL owns central Automation/registry state; existing local T3 SQLite state remains separate. Keep Automation logic and its T3 adapter separate.
- The recorded VPS contains development/test data, but source sessions and credentials are not disposable. Follow the current deployment/runbook authorization rather than inferring operational instructions from this video.
- Initial implementation targets are Linux Main/workers, Web and Windows desktop. Mobile feature work/acceptance is deferred, while shared contracts remain compatible.
- No fixes are authorized merely by this extraction. For later implementation, use the standing branch → focused tests/checks → fork PR → development deployment process. Never commit this source video.

Useful starting points, established by repository file discovery rather than a root-cause audit:

| Topics                                             | Likely starting files/directories                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login, instance access and Resources               | `apps/web/src/foundry/FoundryPage.tsx`, `instanceSession.ts`, `onboarding.ts`, `home.ts`, `routes/foundry.tsx`                                                                                        |
| Sidebar, Factory context, device inventory         | `apps/web/src/foundry/FoundrySidebar.tsx`, `FactoryNavigation.tsx`, `DeviceCatalog.tsx`, `devices.ts`, `useWorkspaceNavigation.ts`                                                                    |
| Factory index, definition source, agents/workflows | `apps/web/src/features/automation/FactoryPage.tsx`, `DefinitionSourcePanel.tsx`, `DefinitionEditor.tsx`, `AgentCatalog.tsx`, `V4Configuration.tsx`, `TriggerPanel.tsx`                                |
| Work items, runs and takeover                      | `apps/web/src/features/automation/WorkItemDetail.tsx`, `RunList.tsx`, `RunDetail.tsx`, `V4RunProgress.tsx`, `HandoffPanel.tsx`; `apps/web/src/foundry/FactoryThreadAccess.tsx`                        |
| Decisions and mutations                            | `apps/web/src/features/automation/InboxPage.tsx`, `InboxDetail.tsx`, `commands.ts`                                                                                                                    |
| Automation services                                | `apps/server/src/automation/`: `Factories.ts`, `Definitions.ts`, `DefinitionSources.ts`, `DefinitionSync.ts`, `Control.ts`, `Inbox.ts`, `Handoffs.ts`, `Runtime.ts`, `V4Execution.ts`, `Workflows.ts` |
| GitHub and trigger execution                       | `apps/server/src/automation/GitHubApp.ts`, `GitHubPolling.ts`, `Triggers.ts`, `Publish.ts`                                                                                                            |
| Shared schema/contracts                            | `packages/contracts/src/automation/`, `packages/contracts/src/foundry*.ts`, `packages/shared/src/factoryDefinition*.ts`                                                                               |

Do not infer that a named file already implements a requested capability. Inspect existing tests and service boundaries before assigning root causes or proposing schema changes.

## Open design decisions to retain

- Exact Factory submenu structure and the role of the global index versus activity feed.
- Which session controls remain visible on browser versus desktop, and which actual session layer causes early logout.
- Definition icon schema, display names and revision-selection/activation UX.
- Precise evaluation scores, cost accounting, efficiency/rework metrics and their evidence.
- Whether closing a decision means personal organization, abandoning a question, or cancelling execution; these require different semantics.
- GitHub command syntax, permitted callers, update cadence and agent freedom in comments.
- Dispatcher/child-workflow limits, durable plan model, cross-repository dependencies, and overseer integration/approval responsibilities.

These questions should not block preserving the explicit requirements above, but the recording does not settle their implementation details.
