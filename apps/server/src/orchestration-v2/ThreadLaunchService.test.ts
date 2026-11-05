import * as Fiber from "effect/Fiber";
import * as EventSink from "./EventSink.ts";
import {
  FoundryWorkerHandoffResult,
  FoundryWorkspaceError,
  FoundryDeviceId,
  EventId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  FoundryArtifactId,
  FoundryInstanceId,
  EnvironmentId,
  FoundryArtifactError,
  type FoundryArtifactManifest,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as ExecutionStore from "../foundry/ExecutionStore.ts";
import * as ArtifactPublication from "../foundry/ArtifactPublication.ts";
import { WorkspaceGate } from "../foundry/workspaces/WorkspaceGate.ts";
import * as ReservationStore from "../foundry/workspaces/ReservationStore.ts";
import type { WriterBinding } from "../foundry/workspaces/ReservationStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as EventStore from "./EventStore.ts";
import * as WorkerLaunch from "../foundry/WorkerLaunch.ts";
import { WorkerReadiness } from "../foundry/WorkerReadiness.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Path from "effect/Path";
import * as DocumentText from "../provider/DocumentText.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChatAttachmentId,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as const;
const claudeAdapter = {
  instanceId: claudeModelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              pinnedAt: null,
              archivedAt: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerThreadManagement, layerProjectedProjects, layerExternalServices),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerOrchestrator,
      layerReceipts,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "succeeded");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      assert.equal(result.threadId, thread!.id);
      const projection = yield* threads.getThreadProjection(thread!.id);
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find(
        (item): item is Extract<typeof item, { type: "user_message" }> =>
          item.type === "user_message",
      );
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect(
  "returns no dispatched thread when sending an automation to a missing thread fails",
  () => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const threadId = ThreadId.make("thread:missing");
      const { task } = yield* tasks.upsert({
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "failed");
      assert.isNull(result.threadId);
      assert.equal(result.task.threadId, threadId);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect("runs a thread-bound automation on the provider the thread uses now", () => {
  const harness = makeHarness({ adapters: [adapter, claudeAdapter] });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({ command: "command:switched", thread: "thread:switched" }),
    );
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make("scheduled-task:switched"),
      title: "Hourly check",
      prompt: "Check on the delegated workers.",
      enabled: false,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: launched.threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:switch-selection"),
      threadId: launched.threadId,
      modelSelection: claudeModelSelection,
    });

    const result = yield* tasks.runNow({ id: task.id });
    assert.equal(result.task.lastRunStatus, "succeeded");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.scheduledTaskId === task.id);
    const run = projection.runs.find((item) => item.id === message?.runId);
    assert.deepStrictEqual(run?.modelSelection, claudeModelSelection);
    assert.deepStrictEqual(projection.thread.modelSelection, claudeModelSelection);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
});

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("provisions independent launches concurrently instead of behind a global semaphore", () =>
  Effect.gen(function* () {
    const setupCount = yield* Ref.make(0);
    const bothEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Ref.updateAndGet(setupCount, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(bothEntered, undefined) : Effect.void,
          ),
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const results = yield* Effect.all(
        [
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-a",
              thread: "thread:launch:concurrent-a",
              message: "First",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
          launches.launch(
            launchInput({
              command: "command:launch:concurrent-b",
              thread: "thread:launch:concurrent-b",
              message: "Second",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result.projection.runs[0]?.status),
        ["preparing", "preparing"],
      );
      yield* Deferred.await(bothEntered);
      assert.equal(yield* Ref.get(setupCount), 2);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([" /COMPACT "])(
  "uses the first conversation message for a title after %s",
  (nativeCommand) =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "compact-title",
            thread: "compact-title-thread",
            message: nativeCommand,
          }),
          generateTitle: true,
        });
        assert.isUndefined(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration,
        );
        assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.lastVisitedAt);
        assert.isFalse(
          (yield* outbox.listByCommandId(CommandId.make("compact-title:initial-message"))).some(
            (effect) => effect.request.type === "thread-title.generate",
          ),
        );
        const commandId = CommandId.make("compact-title-conversation");
        const messageId = MessageId.make("compact-title-conversation-message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId,
          createdBy: "user",
          creationSource: "web",
          text: "Fix the failing parser",
          attachments: [],
          dispatchMode: { type: "defer_start" },
        });
        assert.equal(
          (yield* threads.getThreadProjection(launched.threadId)).thread.titleRegeneration
            ?.requestId,
          commandId,
        );
        assert.deepEqual(
          (yield* outbox.listByCommandId(commandId))
            .filter((effect) => effect.request.type === "thread-title.generate")
            .map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "initial", messageId } }],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps native maintenance commands out of steering and restart messages", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      for (const scenario of [
        {
          name: "compact-steer",
          first: "Fix the parser",
          next: " /COMPACT ",
          mode: "steer_active",
        },
        {
          name: "compact-restart",
          first: "Fix the parser",
          next: "/compact",
          mode: "restart_active",
        },
        {
          name: "logout-steer",
          first: "Fix the parser",
          next: "/logout",
          mode: "steer_active",
        },
        {
          name: "logout-restart",
          first: "Fix the parser",
          next: "/logout",
          mode: "restart_active",
        },
        {
          name: "steer-logout",
          first: "/logout",
          next: "Continue with the parser",
          mode: "steer_active",
        },
        {
          name: "steer-compaction",
          first: "/compact",
          next: "Continue with the parser",
          mode: "steer_active",
        },
      ] as const) {
        const launched = yield* launches.launch(
          launchInput({
            command: `${scenario.name}:launch`,
            thread: scenario.name,
            message: scenario.first,
          }),
        );
        const before = yield* threads.getThreadProjection(launched.threadId);
        const targetRun = before.runs[0];
        if (targetRun === undefined) return yield* Effect.die("Launch must create a run");
        const commandId = CommandId.make(`${scenario.name}:message`);
        const dispatch = threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId: launched.threadId,
          messageId: MessageId.make(`${scenario.name}:message`),
          createdBy: "user",
          creationSource: "web",
          text: scenario.next,
          attachments: [],
          dispatchMode: { type: scenario.mode, targetRunId: targetRun.id },
        });
        if (scenario.name.startsWith("steer-")) {
          yield* dispatch;
          const queued = (yield* threads.getThreadProjection(launched.threadId)).runs[1];
          assert.equal(queued?.status, "queued");
          assert.equal(queued?.userMessageId, MessageId.make(`${scenario.name}:message`));
          continue;
        }
        const failure = yield* dispatch.pipe(Effect.flip);
        assert.include(
          String(failure.cause).toLowerCase(),
          scenario.name.includes("logout") ? "sign" : "context compaction",
        );
        const after = yield* threads.getThreadProjection(launched.threadId);
        assert.deepEqual(after.messages, before.messages);
        assert.deepEqual(after.thread.titleRegeneration, before.thread.titleRegeneration);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("arms durable title generation after accepting the first message", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      generateTitle: (input) =>
        Effect.succeed({
          title: input.previousTitle === undefined ? "Generated title" : "Regenerated title",
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
      const input = {
        ...launchInput({
          command: "command:launch:title-generation",
          thread: "thread:launch:title-generation",
          message: "Generate my title",
        }),
        title: "Generate my title",
        generateTitle: true,
      };
      const launched = yield* launches.launch(input);
      const generationCommandId = CommandId.make("command:launch:title-generation:initial-message");

      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.thread.title, "Generate my title");
      assert.equal(projection.thread.titleRegeneration?.requestId, generationCommandId);
      assert.deepEqual(
        (yield* outbox.listByCommandId(generationCommandId)).map((effect) => effect.request),
        [
          {
            type: "thread-title.generate",
            kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
          },
        ],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: generationCommandId,
        kind: { type: "initial", messageId: MessageId.make("Generate my title:id") },
      });
      const generated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(generated.thread.title, "Generated title");
      assert.deepEqual(
        harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );

      const manualRequestId = CommandId.make("command:title-generation:manual");
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: manualRequestId,
        threadId: launched.threadId,
        regenerateTitle: true,
      });
      assert.deepEqual(
        (yield* outbox.listByCommandId(manualRequestId)).map((effect) => effect.request),
        [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
      );
      yield* titleRegeneration.execute({
        threadId: launched.threadId,
        requestId: manualRequestId,
        kind: { type: "regenerate" },
      });
      const regenerated = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(regenerated.thread.title, "Regenerated title");
      assert.equal(
        harness.generateThreadTitle.mock.calls[1]?.[0]?.previousTitle,
        "Generated title",
      );

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("command:title-generation:user-rename"),
        threadId: launched.threadId,
        title: "Keep my title",
      });
      const renamed = yield* threads.getThreadProjection(launched.threadId);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* threads.dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make("command:title-generation:stale-completion"),
        threadId: launched.threadId,
        requestId: generationCommandId,
        title: "Stale generated title",
      });
      const afterStaleCompletion = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(afterStaleCompletion.thread.title, "Keep my title");
      assert.equal(
        DateTime.toEpochMillis(afterStaleCompletion.thread.updatedAt),
        DateTime.toEpochMillis(renamed.thread.updatedAt),
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not update a reused thread title when the initial message is rejected", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

// Stands `projectId` in for the Scratch project: a plain folder, not a Git
// repository, so Git fails there with the error a real one raises.
function scratchHarness() {
  const claimed: Array<ThreadId> = [];
  const scratchRoot = project.workspaceRoot;
  const notARepository = (operation: string, cwd: string) =>
    new GitCommandError({
      operation,
      command: "vcs-route",
      cwd,
      detail: "Failed to resolve the VCS driver for this Git command.",
    });
  const harness = makeHarness({
    managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (id) => Effect.succeed(id === projectId),
      folderForThread: (input) =>
        Effect.sync(() => {
          if (input.projectId !== projectId) return Option.none();
          claimed.push(input.threadId);
          return Option.some(`/scratch/folder-${claimed.length}`);
        }),
    }),
    remoteExists: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.remoteExists", input.cwd))
        : Effect.succeed(true),
    createWorktree: (input) =>
      input.cwd === scratchRoot
        ? Effect.fail(notARepository("GitWorkflowService.createWorktree", input.cwd))
        : Effect.succeed({
            worktree: {
              path: "/other-repo-worktrees/feature",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
  });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return {
    ...harness,
    claimed,
    layer: Layer.mergeAll(harness.layer, layerScheduledTasks),
  };
}

const worktreeStrategy = { type: "worktree", baseRef: "main", startFromOrigin: true } as const;

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

function scheduledTaskInput(id: string, targetProjectId: ProjectId) {
  return {
    id: ScheduledTaskId.make(id),
    title: "Daily summary",
    prompt: "Summarize the day.",
    enabled: false,
    schedule: { type: "interval" as const, everyMs: 60_000 },
    projectId: targetProjectId,
    threadId: null,
    workspaceStrategy: worktreeStrategy,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  };
}

it.effect("launches a worktree request for Scratch at the root, in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:scratch-worktree",
        thread: "thread:launch:scratch-worktree",
        message: "Tidy my notes",
        workspace: worktreeStrategy,
      }),
    );
    const scratch = yield* preparationSettled(launched.threadId);
    assert.equal(scratch.thread.worktreePath, "/scratch/folder-1");
    // Released past preparation; provider execution is disabled here.
    assert.equal(scratch.runs[0]?.status, "starting");
    assert.deepEqual(scratch.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    // A Git project still gets the worktree it asked for.
    const other = yield* launches.launch({
      ...launchInput({
        command: "command:launch:git-worktree",
        thread: "thread:launch:git-worktree",
        message: "Build the feature",
        workspace: worktreeStrategy,
      }),
      projectId: otherProjectId,
    });
    const git = yield* preparationSettled(other.threadId);
    assert.equal(git.runs[0]?.status, "starting");
    assert.equal(git.runs[0]?.workspacePreparation?.type, "worktree");
    assert.equal(git.thread.worktreePath, "/other-repo-worktrees/feature");
    assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.cwd, "/other-repo");
    assert.deepEqual(harness.claimed, [launched.threadId]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stores a Scratch scheduled task at the root and keeps worktrees elsewhere", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const scratch = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-upsert", projectId),
    );
    assert.deepEqual(scratch.task.workspaceStrategy, { type: "root" });
    const git = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:git-upsert", otherProjectId),
    );
    assert.deepEqual(git.task.workspaceStrategy, worktreeStrategy);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("runs a Scratch scheduled task saved with a worktree in its own folder", () => {
  const harness = scratchHarness();
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;
    const { task } = yield* tasks.upsert(
      scheduledTaskInput("scheduled-task:scratch-stored", projectId),
    );
    // Tasks saved before Scratch was coerced still hold a worktree strategy.
    yield* sql`
      UPDATE scheduled_tasks
      SET workspace_strategy_json = ${JSON.stringify(worktreeStrategy)}
      WHERE task_id = ${task.id}
    `;
    const ran = yield* tasks.runNow({ id: task.id });
    assert.equal(ran.task.lastRunStatus, "succeeded");
    const [thread] = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
    assert.isDefined(thread);
    const projection = yield* preparationSettled(thread!.id);
    assert.equal(projection.runs[0]?.status, "starting");
    assert.equal(projection.thread.worktreePath, "/scratch/folder-1");
    assert.deepEqual(projection.runs[0]?.workspacePreparation, {
      type: "existing_worktree",
      worktreePath: "/scratch/folder-1",
    });
    assert.equal(harness.runSetup.mock.calls[0]?.[0]?.worktreePath, "/scratch/folder-1");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["stable", "upstream/release"])(
  "launches from %s with the fetched commit and remote PR base",
  (baseRef) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "launch-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      const localHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote advance"]);
      yield* command(cwd, ["push", "upstream", "stable:release"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["reset", "--hard", localHead]);
      yield* command(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);

      const setupStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        hasCommit: ({ refName }) =>
          command(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          hasRefNamed: () => Effect.succeed(false),
        },
        fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
        createWorktree: (input, options) =>
          git.createWorktree({ ...input, cwd, path: worktreePath }, options),
        runSetup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const workspace = {
          type: "worktree" as const,
          baseRef,
          branch: "feature",
          startFromOrigin: true,
        };
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:remote-base",
            thread: "thread:launch:remote-base",
            workspace,
          }),
        );
        yield* Deferred.await(setupStarted);
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.thread.worktreePath, worktreePath);
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          remoteHead,
        );
        const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
          remoteHead,
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-remote-git-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("shows the fetch diagnosis when preparing a worktree from origin fails", () => {
  const detail =
    "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.fetchRemote",
          command: "git",
          cwd: project.workspaceRoot,
          detail,
          exitCode: 128,
        }),
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:fetch-failure",
        thread: "thread:launch:fetch-failure",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.messages[0]?.text, "Start from origin");
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(projection.thread.worktreePath, null);
    assert.equal(
      projection.turnItems.find((item) => item.type === "command_execution")?.status,
      "failed",
    );
    assert.include(
      projection.turnItems.find((item) => item.type === "error")?.failure.message ?? "",
      detail,
    );
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.equal(harness.runSetup.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a preparation retry after the project disables its provider", () => {
  let fetchAttempts = 0;
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      fetchAttempts++ === 0
        ? Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git",
              cwd: project.workspaceRoot,
              detail: "Git could not reach the remote.",
              exitCode: 128,
            }),
          )
        : Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:disabled-preparation-retry",
        thread: "thread:launch:disabled-preparation-retry",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* preparationSettled(launched.threadId);
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const error = yield* launches
      .retryPreparation({
        commandId: CommandId.make("command:launch:disabled-preparation-retry:retry"),
        threadId: launched.threadId,
        runId: launched.projection.runs[0]!.id,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "ThreadManagementProviderInstanceDisabledError");
    assert.equal((yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status, "failed");
    assert.equal(fetchAttempts, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not release a prepared run after the project disables its provider", () => {
  return Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:disable-during-preparation",
          thread: "thread:launch:disable-during-preparation",
          message: "Prepare a worktree",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* Deferred.await(setupEntered);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
        },
      });
      yield* Deferred.succeed(allowSetup, undefined);
      const projection = yield* preparationSettled(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make("command:launch:disable-during-preparation:release"),
      );
      assert.isFalse(
        effects.some(
          (effect) =>
            effect.request.type === "provider-turn.start" &&
            effect.request.runId === launched.projection.runs[0]?.id,
        ),
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

it.effect.each(["fails", "is interrupted"] as const)(
  "holds a message queued during setup when the workspace preparation %s",
  (ending) =>
    Effect.gen(function* () {
      const fetchEntered = yield* Deferred.make<void>();
      const allowFetch = yield* Deferred.make<void>();
      let fetchFailures = 1;
      const harness = makeHarness({
        fetchWorktreeBaseCommit: () =>
          fetchFailures-- <= 0
            ? Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })
            : Deferred.succeed(fetchEntered, undefined).pipe(
                Effect.andThen(Deferred.await(allowFetch)),
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.fetchRemote",
                      command: "git",
                      cwd: project.workspaceRoot,
                      detail: "Git could not reach the remote.",
                      exitCode: 128,
                    }),
                  ),
                ),
              ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launched = yield* launches.launch(
          launchInput({
            command: `command:launch:queued-setup-${ending}`,
            thread: `thread:launch:queued-setup-${ending}`,
            message: "First message",
            workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
          }),
        );
        yield* Deferred.await(fetchEntered);
        const queued = yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make(`command:launch:queued-setup-${ending}:follow-up`),
          threadId: launched.threadId,
          messageId: MessageId.make(`message:launch:queued-setup-${ending}:follow-up`),
          text: "Sent during setup",
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(queued.delivery, "queued");
        if (ending === "fails") {
          yield* Deferred.succeed(allowFetch, undefined);
        } else {
          yield* threads.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:launch:queued-setup-interrupt"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
        }

        yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
        );
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.runs.at(-1)?.status, "queued");
        assert.equal(projection.thread.worktreePath, null);

        if (ending === "fails") {
          yield* launches.retryPreparation({
            commandId: CommandId.make("command:launch:queued-setup-retry"),
            threadId: launched.threadId,
            runId: launched.projection.runs[0]!.id,
          });
          const retried = yield* threads.getThreadProjection(launched.threadId);
          assert.equal(retried.runs.at(-1)?.queueHeld, false);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["failed", "interrupted"] as const)(
  "holds a message queued during setup that arrives after the setup %s",
  (ending) => {
    let fetchEntered: Deferred.Deferred<void> | null = null;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        ending === "interrupted"
          ? Deferred.succeed(fetchEntered!, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
    });
    return Effect.gen(function* () {
      fetchEntered = yield* Deferred.make<void>();
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:late-queued-follow-up-${ending}`,
          thread: `thread:launch:late-queued-follow-up-${ending}`,
          message: "First message",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      if (ending === "interrupted") {
        yield* Deferred.await(fetchEntered);
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:launch:late-queued-follow-up:interrupt"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) => stored.event.type === "run.updated" && stored.event.payload.status === ending,
        ),
        Stream.runHead,
      );

      const queued = yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:send`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:send`),
        text: "Sent during setup",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(queued.delivery, "queued");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      const held = projection.runs.at(-1)!;
      assert.equal(held.status, "queued");
      assert.equal(held.queueHeld, true);

      // A message the user starts does not release it: the held message would
      // run after it in the project checkout.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:start`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:start`),
        text: "Sent after setup",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:wake`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:wake`),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      const wake = (yield* threads.getThreadProjection(launched.threadId)).runs.at(-1)!;
      assert.equal(wake.status, "queued");
      assert.isTrue(wake.queueHeld);

      // Nor does the next one, though the run that message started is now the
      // latest and carries no workspace preparation.
      yield* threads.sendToThread({
        projectId,
        commandId: CommandId.make(`command:launch:late-queued-follow-up-${ending}:again`),
        threadId: launched.threadId,
        messageId: MessageId.make(`message:launch:late-queued-follow-up-${ending}:again`),
        text: "Sent after that",
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(launched.threadId);
      assert.isTrue(after.runs.find((run) => run.id === held.id)?.queueHeld);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const first = yield* launches.launch(rest);
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      // Clients drop their pending copy once the thread reaches the message's commit.
      assert.isNumber(first.sequence);
      assert.equal(retry.sequence, first.sequence);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted launch after the project disables the instance", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const input = launchInput({
      command: "command:launch:retry-after-disable",
      thread: "thread:launch:retry-after-disable",
      message: "Hello",
    });
    const first = yield* launches.launch(input);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* launches.launch(input);
    assert.equal(retry.threadId, first.threadId);
    assert.isTrue(retry.resumed);

    const fresh = yield* launches
      .launch(
        launchInput({
          command: "command:launch:fresh-after-disable",
          thread: "thread:launch:fresh-after-disable",
          message: "Hello",
        }),
      )
      .pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("an agent's launch never starts work above the modes it asks for", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    // The first launch, at full access, creates the thread without a message.
    const created = yield* launches.launch(
      launchInput({ command: "command:launch:narrowed-retry", thread: "thread:narrowed" }),
    );
    // The same key comes back from a narrower agent, now carrying a message,
    // as a retry or a concurrent launch that lost the create would.
    const failed = yield* launches
      .launch({
        ...launchInput({
          command: "command:launch:narrowed-retry",
          thread: "thread:narrowed",
          message: "Run this",
        }),
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "dispatch-message");
    const projection = yield* threads.getThreadProjection(created.threadId);
    assert.equal(projection.runs.length, 0);
    assert.equal(projection.messages.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        if (error._tag !== "ThreadLaunchError") {
          assert.fail(`expected ThreadLaunchError, got ${error._tag}`);
        }
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
                workspace: { type: "worktree", baseRef: "main" },
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("reports one concurrent same-command launch as new and the rest as resumed", () =>
  Effect.gen(function* () {
    // Both launches read no receipt before either one claims the thread.
    const arrived = yield* Ref.make(0);
    const bothRead = yield* Deferred.make<void>();
    const harness = makeHarness({
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () =>
          Ref.updateAndGet(arrived, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothRead, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(bothRead)),
            Effect.as(Option.none()),
          ),
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const input = launchInput({
        command: "command:launch:concurrent-resumed",
        thread: "thread:launch:concurrent-resumed",
      });
      const results = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(results.map((result) => result.resumed).sort(), [false, true]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "does not report a retry as resumed when the earlier attempt only claimed the thread",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const input = launchInput({
          command: "command:launch:claimed-only",
          thread: "thread:launch:claimed-only",
          message: "Counted once",
        });
        yield* threads.dispatch({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        const retried = yield* launches.launch(input);
        assert.isFalse(retried.resumed);
        assert.isTrue((yield* launches.launch(input)).resumed);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("schedules an accepted preparing message exactly once across concurrent retries", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:accepted-before-fork",
        thread: "thread:launch:accepted-before-fork",
        message: "Resume preparation",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const messageId = MessageId.make("message:launch:accepted-before-fork");

      yield* threads.dispatch({
        type: "thread.create",
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:initial-message`),
        threadId: input.threadId,
        messageId,
        text: "Resume preparation",
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode: { type: "defer_start" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const preparing = yield* threads.getThreadProjection(input.threadId);
      assert.equal(preparing.runs[0]?.status, "preparing");

      const [first, second] = yield* Effect.all([launches.launch(input), launches.launch(input)], {
        concurrency: "unbounded",
      });
      yield* Deferred.await(setupEntered);
      assert.isTrue(first.resumed);
      assert.isTrue(second.resumed);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("creates a strong provider-thread mapping for an imported native session", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const input = {
      ...launchInput({
        command: "command:launch:imported-native-session",
        thread: "thread:launch:imported-native-session",
      }),
      importedNativeThread: {
        ref: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-session-42",
          strength: "strong" as const,
        },
        metadata: {
          title: "Native session",
          updatedAt: "2026-08-23T00:00:00Z",
        },
      },
    };

    const launched = yield* launches.launch(input);

    assert.deepInclude(launched.projection.providerThreads[0], {
      id: IdAllocator.deriveProviderThread({
        driver: input.importedNativeThread.ref.driver,
        providerInstanceId: modelSelection.instanceId,
        nativeThreadId: input.importedNativeThread.ref.nativeId,
      }),
      driver: input.importedNativeThread.ref.driver,
      providerInstanceId: modelSelection.instanceId,
      appThreadId: input.threadId,
      nativeThreadRef: input.importedNativeThread.ref,
      status: "not_loaded",
      nativeMetadata: input.importedNativeThread.metadata,
    });
    assert.equal(
      launched.projection.thread.activeProviderThreadId,
      launched.projection.providerThreads[0]?.id,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-message-intake-" }).pipe(
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](t3-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
        checkWorktreeBase: launches.checkWorktreeBase,
        retryPreparation: launches.retryPreparation,
        prepareRun: launches.prepareRun,
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    const record = stored.context?.records[0];
    assert.isDefined(record);
    assert.equal((record as { attachmentId: string }).attachmentId, stored.attachments[0]?.id);
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const replayed = yield* ThreadMessageIntake.launchThread(input);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const duplicate = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-duplicate-create"),
      initialMessage: { ...input.initialMessage, messageId: MessageId.make("intake-duplicate") },
    }).pipe(Effect.result);
    assert.ok(Result.isFailure(duplicate));
    assert.ok(duplicate.failure._tag === "ThreadLaunchError");
    assert.equal(duplicate.failure.operation, "create-thread");
    assert.propertyVal(duplicate.failure.cause, "_tag", "OrchestratorThreadAlreadyExistsError");
    assert.equal((yield* claimedFiles).length, 1);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    const dispatch = ThreadMessageIntake.dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch;
    yield* dispatch;
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* ThreadMessageIntake.dispatchCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect("cancels tracked setup before provider work is released", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const input = launchInput({
        command: "launch:cancel-tracked",
        thread: "thread:cancel-tracked",
        message: "Start",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(entered);
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
      const projection = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.isNull(projection.thread.worktreePath);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${input.commandId}:release`)));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("stops an in-flight branch rename when tracked setup is cancelled", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const branchNameStarted = yield* Deferred.make<void>();
    const allowBranchName = yield* Deferred.make<void>();
    const branchNameInterrupted = yield* Deferred.make<void>();
    const renameAttempted = yield* Deferred.make<void>();
    const harness = makeHarness({
      renameBranch: (input) =>
        Deferred.succeed(renameAttempted, undefined).pipe(Effect.as({ branch: input.newBranch })),
      runSetup: () => Deferred.succeed(setupEntered, undefined).pipe(Effect.andThen(Effect.never)),
      generateBranchName: () =>
        Deferred.succeed(branchNameStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowBranchName)),
          Effect.as({ branch: "generated-branch" }),
          Effect.onInterrupt(() => Deferred.succeed(branchNameInterrupted, undefined)),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:cancel-renaming",
          thread: "thread:cancel-renaming",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* Deferred.await(setupEntered);
      yield* Deferred.await(branchNameStarted);
      assert.isTrue(yield* tracker.cancel(launched.threadId));
      yield* Deferred.succeed(allowBranchName, undefined);
      yield* Effect.raceFirst(
        Deferred.await(branchNameInterrupted),
        Deferred.await(renameAttempted),
      );
      assert.isTrue(
        yield* Deferred.isDone(branchNameInterrupted),
        "the cancelled setup's branch rename kept running",
      );
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.isNull((yield* threads.getThreadProjection(launched.threadId)).thread.worktreePath);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([0, 1])("releases an async setup before its completion with exit %s", (exitCode) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<{ exitCode: number | null; durationMs: number }>();
    const harness = makeHarness({
      runSetup: () =>
        Effect.succeed({
          status: "started" as const,
          async: true,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup",
          cwd: "/repo-worktrees/feature",
          completion: Deferred.await(completion),
        }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: `command:launch:async-${exitCode}`,
          thread: `thread:launch:async-${exitCode}`,
          message: "Start during setup",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter(
          (snapshot) =>
            snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
            true,
        ),
        Stream.runHead,
      );
      const running = yield* threads.getThreadProjection(launched.threadId);
      assert.equal(running.runs[0]?.status, "starting");
      assert.equal((yield* tracker.get(launched.threadId))?.phase, "running");
      yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase === "done"),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.equal(
        settled?.stages.find((stage) => stage.id === "setup-script")?.status,
        exitCode === 0 ? "done" : "failed",
      );
      assert.equal(
        (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "is missing", baseRef: "t3/renamed", startFromOrigin: false, origin: true },
  {
    name: "has no origin to come from",
    baseRef: "t3/renamed",
    startFromOrigin: true,
    origin: false,
  },
  {
    name: "is a previous checkout there never was",
    baseRef: "-",
    startFromOrigin: false,
    origin: true,
  },
])("refuses a new worktree whose base ref $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD"),
      git: {
        resolveWorktreeBaseRemote: () =>
          Effect.succeed(testCase.origin ? { remoteName: "origin", branchName: "main" } : null),
        hasRefNamed: () => Effect.succeed(false),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: testCase.baseRef,
            startFromOrigin: testCase.startFromOrigin,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBaseRefError",
        projectId,
        baseRef: testCase.baseRef,
      });
      assert.equal(
        error.message,
        `Base ref "${testCase.baseRef}" does not resolve to a commit in project "Project" (/repo).`,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays an accepted send after the project disables the instance", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-send-retry-" }).pipe(
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const created = yield* launches.launch(
      launchInput({
        command: "command:send:retry-setup",
        thread: "thread:send:retry-after-disable",
      }),
    );

    const sendInput = {
      commandId: CommandId.make("command:send:retry-after-disable"),
      projectId,
      threadId: created.threadId,
      messageId: MessageId.make("message:send:retry-after-disable"),
      text: "Hello again",
      attachments: [],
      mode: "auto" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const first = yield* ThreadMessageIntake.sendToThread(sendInput);

    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const retry = yield* ThreadMessageIntake.sendToThread(sendInput);
    assert.equal(retry.message.id, first.message.id);

    const fresh = yield* ThreadMessageIntake.sendToThread({
      ...sendInput,
      commandId: CommandId.make("command:send:fresh-after-disable"),
      messageId: MessageId.make("message:send:fresh-after-disable"),
    }).pipe(Effect.flip);
    if (fresh._tag !== "ThreadManagementProviderInstanceDisabledError") {
      assert.fail(`expected ThreadManagementProviderInstanceDisabledError, got ${fresh._tag}`);
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

const encodeHandoffResult = Schema.encodeEffect(Schema.fromJsonString(FoundryWorkerHandoffResult));

function workerLayer(
  roots = ["/repo"],
  providerReady = true,
  enabled = true,
  checkpointExists = false,
  checkpointOverrides: Partial<CheckpointStore.CheckpointStore["Service"]> = {},
  filesystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    realPath: (path) => Effect.succeed(path),
  }),
  capacity = 1,
) {
  return WorkerLaunch.layer.pipe(
    Layer.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "worker-git-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(RuntimePolicy.layer),
    Layer.provideMerge(ExecutionStore.layer),
    Layer.provide(
      Layer.succeed(CheckpointStore.CheckpointStore, {
        isGitRepository: () => Effect.succeed(true),
        hasCheckpointRef: () => Effect.succeed(checkpointExists),
        captureCheckpoint: () => Effect.void,
        restoreCheckpoint: () => Effect.succeed(false),
        diffCheckpoints: () => Effect.succeed(""),
        listAuthoredPaths: () => Effect.succeed(new Set<string>()),
        deleteCheckpointRefs: () => Effect.void,
        ...checkpointOverrides,
      }),
    ),
    Layer.provide(EventStore.layer),
    Layer.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              FOUNDRY_WORKER_ENABLED: String(enabled),
              FOUNDRY_WORKER_PROVIDER_INSTANCE_ID: "codex",
              FOUNDRY_WORKER_WORKSPACE_ROOTS: JSON.stringify(roots),
            },
          }),
        ),
        Path.layer,
        filesystemLayer,
        Layer.succeed(WorkerReadiness, {
          read: () =>
            Effect.succeed({
              online: true,
              providerInstanceId: modelSelection.instanceId,
              providerReady,
              providerState: "ready",
              version: "fixture",
              checkedAt: "2026-01-01T00:00:00.000Z",
              capacityAvailable: true,
              activeRuns: 0,
              capacity,
            }),
        }),
      ),
    ),
  );
}
const workerInput = {
  commandId: CommandId.make("worker-launch-fixture"),
  projectId,
  title: "Worker task",
  model: modelSelection.model,
  prompt: "An isolated launch without a parent agent",
};

it.effect.each(["stopped", "unproven", "unavailable", "other-instance"] as const)(
  "worker recovers native writer evidence after losing its local session: %s",
  (history) => {
    const open = vi.fn<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>((input) =>
      Effect.gen(function* () {
        if (history === "unavailable")
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: adapter.driver,
            providerSessionId: input.providerSessionId,
          });
        const now = yield* DateTime.now;
        return {
          instanceId: adapter.instanceId,
          driver: adapter.driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? "/repo",
            model: input.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          confirmWriterEnded: (probe) => {
            assert.equal(probe.nativeTurnId, "interrupted-native-turn");
            assert.equal(probe.providerThread.nativeThreadRef?.nativeId, "original-native-thread");
            return Effect.succeed(history === "stopped");
          },
          ensureThread: () => Effect.die("Recovery must not create a native thread"),
          resumeThread: () => Effect.die("Recovery must not resume a native thread"),
          startTurn: () => Effect.die("Recovery must not start a native turn"),
          steerTurn: () => Effect.die("Recovery must not steer a native turn"),
          interruptTurn: () => Effect.die("Recovery must only inspect native history"),
          respondToRuntimeRequest: () => Effect.die("Recovery must not approve commands"),
          readThreadSnapshot: () => Effect.die("Recovery must use the writer verifier"),
          rollbackThread: () => Effect.die("Recovery must not roll back a native thread"),
          forkThread: () => Effect.die("Recovery must not fork a native thread"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
    );
    const harness = makeHarness({ adapters: [{ ...adapter, openSession: open }] });
    return Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const store = yield* ExecutionStore.ExecutionStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
      const receipt = yield* worker.launch(workerInput);
      const { runs } = yield* threads.getThreadRecords(receipt.threadId, ["runs"]);
      const run = runs[0]!;
      const attemptId = RunAttemptId.make("crashed-worker-attempt");
      const providerThreadId = ProviderThreadId.make("crashed-worker-provider-thread");
      const providerSessionId = ProviderSessionId.make("crashed-worker-provider-session");
      assert.isTrue(
        yield* store.starting({ threadId: receipt.threadId, providerThreadId, runOrdinal: 1 }),
      );
      yield* store.stop(workerInput.commandId);
      yield* store.uncertain(workerInput.commandId);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("crashed-worker-provider-thread"),
            type: "provider-thread.updated",
            threadId: receipt.threadId,
            driver: adapter.driver,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: adapter.driver,
              providerInstanceId:
                history === "other-instance"
                  ? ProviderInstanceId.make("other-codex")
                  : adapter.instanceId,
              providerSessionId,
              appThreadId: receipt.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: adapter.driver,
                nativeId: "original-native-thread",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("crashed-worker-provider-turn"),
            type: "provider-turn.updated",
            threadId: receipt.threadId,
            runId: run.id,
            driver: adapter.driver,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("crashed-worker-provider-turn"),
              providerThreadId,
              nodeId: NodeId.make("crashed-worker-node"),
              runAttemptId: attemptId,
              nativeTurnRef: {
                driver: adapter.driver,
                nativeId: "interrupted-native-turn",
                strength: "strong",
              },
              ordinal: 1,
              status: "interrupted",
              startedAt: now,
              completedAt: now,
            },
          },
          {
            id: EventId.make("crashed-worker-run"),
            type: "run.updated",
            threadId: receipt.threadId,
            occurredAt: now,
            payload: {
              ...run,
              status: "interrupted",
              providerThreadId,
              activeAttemptId: attemptId,
              completedAt: now,
            },
          },
        ],
      });
      assert.isTrue(Option.isNone(yield* sessions.get(providerSessionId)));
      const result = yield* worker.read({ commandId: workerInput.commandId });
      if (history === "stopped") {
        assert.isTrue(result.lifecycle?.writerEnded);
        assert.equal(result.lifecycle?.state, "stopped");
        assert.deepInclude(result.lifecycle?.manifest, {
          outcome: "stopped",
          runId: run.id,
          checkpointId: null,
        });
        assert.deepEqual(
          (yield* worker.read({ commandId: workerInput.commandId })).lifecycle?.manifest,
          result.lifecycle?.manifest,
        );
      } else {
        assert.isFalse(result.lifecycle?.writerEnded);
        assert.equal(result.lifecycle?.state, "uncertain");
        assert.isNull(result.lifecycle?.manifest);
      }
      assert.equal(open.mock.calls.length, history === "other-instance" ? 0 : 1);
      if (open.mock.calls[0]) {
        assert.deepEqual(open.mock.calls[0][0].modelSelection, run.modelSelection);
        assert.equal(open.mock.calls[0][0].initialNativeThreadId, "original-native-thread");
      }
      assert.deepEqual(yield* worker.launch(workerInput), receipt);
      assert.lengthOf((yield* threads.getThreadRecords(receipt.threadId, ["runs"])).runs, 1);
    }).pipe(Effect.provide(workerLayer().pipe(Layer.provideMerge(harness.layer))));
  },
);

it.effect.each([
  "before-commit",
  "after-thread-commit",
  "after-message-commit",
  "lost-response",
  "configured-options",
] as const)("worker receipt survives %s and recreation of its service", (failurePoint) => {
  const harness = makeHarness();
  const input = {
    ...workerInput,
    ...(failurePoint === "configured-options"
      ? { options: { reasoningEffort: "high" as const } }
      : {}),
  };
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const ids = WorkerLaunch.workerLaunchIds(input, "codex");
    const legacyIds = WorkerLaunch.workerLaunchIds(workerInput, "codex");
    assert.equal(ids.commandId, legacyIds.commandId);
    if (failurePoint === "configured-options") assert.notEqual(ids.threadId, legacyIds.threadId);
    else assert.equal(ids.threadId, legacyIds.threadId);
    if (failurePoint === "before-commit") {
      const fault = Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: () =>
          Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              commandId: ids.commandId,
              projectId,
              operation: "create-thread",
              cause: "injected before commit",
            }),
          ),
      });
      const failed = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
        worker.launch(input),
      ).pipe(Effect.provide(workerLayer().pipe(Layer.provide(fault))), Effect.flip);
      assert.deepInclude(failed, { code: "launch_failed" });
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(ids.commandId)));
    } else if (failurePoint === "after-thread-commit") {
      yield* threads.dispatch({
        type: "thread.create",
        ...ids,
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      assert.isTrue(
        Option.isNone(
          yield* receipts.getByCommandId(CommandId.make(`${ids.commandId}:initial-message`)),
        ),
      );
    } else if (failurePoint === "after-message-commit") {
      const interruptedLaunch = Layer.fresh(ThreadLaunch.layer).pipe(
        Layer.provide(IdAllocator.layer),
        Layer.provide(
          Layer.succeed(ThreadManagement.ThreadManagementService, {
            ...threads,
            dispatch: (command) =>
              threads
                .dispatch(command)
                .pipe(
                  Effect.tap(() =>
                    command.type === "message.dispatch"
                      ? Effect.die("injected exit after message commit")
                      : Effect.void,
                  ),
                ),
          }),
        ),
      );
      const stopped = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
        worker.launch(input),
      ).pipe(Effect.provide(workerLayer().pipe(Layer.provide(interruptedLaunch))), Effect.exit);
      assert.isTrue(Exit.isFailure(stopped));
      if (Exit.isFailure(stopped))
        assert.include(Cause.pretty(stopped.cause), "injected exit after message commit");
      assert.isTrue(
        Option.isSome(
          yield* receipts.getByCommandId(CommandId.make(`${ids.commandId}:initial-message`)),
        ),
      );
    } else {
      // The durable launch completes but its response is lost before the caller sees it.
      yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) => worker.launch(input)).pipe(
        Effect.provide(workerLayer()),
        Effect.andThen(Effect.fail("lost response")),
        Effect.flip,
      );
    }
    const recoveredRead = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.read({ commandId: input.commandId }),
    ).pipe(Effect.provide(workerLayer()), Effect.result);
    if (failurePoint === "before-commit" || failurePoint === "after-thread-commit") {
      assert.isTrue(Result.isFailure(recoveredRead));
      if (Result.isFailure(recoveredRead))
        assert.deepInclude(recoveredRead.failure, { code: "not_found" });
    } else {
      assert.isTrue(Result.isSuccess(recoveredRead));
      if (Result.isSuccess(recoveredRead))
        assert.equal(recoveredRead.success.receipt.threadId, ids.threadId);
    }
    const first = yield* Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const receipt = yield* worker.launch(input);
      if (failurePoint === "before-commit") {
        const store = yield* ExecutionStore.ExecutionStore;
        const row = yield* store.read(input.commandId);
        assert.equal(row?.stopRequested, 1);
        assert.isFalse(yield* store.renew(input.commandId, row!.generation));
        assert.isFalse(
          yield* store.starting({
            threadId: receipt.threadId,
            providerThreadId: ProviderThreadId.make("must-not-revive"),
            runOrdinal: 1,
          }),
        );
      }
      return receipt;
    }).pipe(Effect.provide(workerLayer()));
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });
    const second = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch(input),
    ).pipe(Effect.provide(workerLayer()));
    assert.deepEqual(first, second);
    assert.equal(first.threadId, ids.threadId);
    const projection = yield* threads.getThreadProjection(first.threadId);
    assert.equal(projection.messages.length, 1);
    assert.equal(projection.runs.length, 1);
    const expectedModelSelection = {
      ...modelSelection,
      ...(input.options ? { options: [{ id: "reasoningEffort", value: "high" }] } : {}),
    };
    assert.deepEqual(projection.thread.modelSelection, expectedModelSelection);
    assert.deepEqual(projection.runs[0]!.modelSelection, expectedModelSelection);
    const execution = yield* Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      if (failurePoint === "after-message-commit")
        yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "interrupted",
          ),
          Stream.runHead,
        );
      return yield* worker.read({ commandId: input.commandId });
    }).pipe(Effect.provide(workerLayer(["/other"], false)));
    assert.deepEqual(execution.receipt, first);
    assert.deepInclude(execution.run, {
      id: projection.runs[0]!.id,
      checkpointId: projection.runs[0]!.checkpointId,
    });
    if (failurePoint === "after-message-commit") assert.equal(execution.run.status, "interrupted");
    assert.equal(
      (yield* threads.listProjectThreads({ projectId, includeSubagents: true })).length,
      1,
    );
    const conflict = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch({ ...input, prompt: "Different request" }),
    ).pipe(Effect.provide(workerLayer()), Effect.flip);
    assert.deepInclude(conflict, { code: "command_conflict" });
    const changedOptions = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch({ ...input, options: { reasoningEffort: "low" } }),
    ).pipe(Effect.provide(workerLayer()), Effect.flip);
    assert.deepInclude(changedOptions, { code: "command_conflict" });
    if (input.options) {
      const removedOptions = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
        worker.launch(workerInput),
      ).pipe(Effect.provide(workerLayer()), Effect.flip);
      assert.deepInclude(removedOptions, { code: "command_conflict" });
    }
    assert.equal((yield* threads.getThreadProjection(first.threadId)).messages.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("worker rejects outside projects and disabled providers before committing work", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const disabledRead = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (disabledWorker) =>
      disabledWorker.read({ commandId: workerInput.commandId }),
    ).pipe(Effect.provide(workerLayer(["/repo"], true, false)), Effect.flip);
    assert.deepInclude(disabledRead, { code: "not_enabled" });
    const disabledFollow = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.follow({ commandId: workerInput.commandId }).pipe(Stream.runHead),
    ).pipe(Effect.provide(workerLayer(["/repo"], true, false)), Effect.flip);
    assert.deepInclude(disabledFollow, { code: "not_enabled" });
    const disabledCancel = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.cancel({
        commandId: CommandId.make("disabled-cancel"),
        launchCommandId: workerInput.commandId,
      }),
    ).pipe(Effect.provide(workerLayer(["/repo"], true, false)), Effect.flip);
    assert.deepInclude(disabledCancel, { code: "not_enabled" });

    for (const roots of [[], ["/other"], ["/rep"], ["relative"]]) {
      const denied = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
        worker.launch(workerInput),
      ).pipe(Effect.provide(workerLayer(roots)), Effect.flip);
      assert.deepInclude(denied, { code: "project_denied" });
    }
    const notReady = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch(workerInput),
    ).pipe(Effect.provide(workerLayer(["/repo"], false)), Effect.flip);
    assert.deepInclude(notReady, { code: "provider_not_ready" });
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });
    const disabled = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch(workerInput),
    ).pipe(Effect.provide(workerLayer()), Effect.flip);
    assert.deepInclude(disabled, { code: "provider_disabled" });
    assert.equal(
      (yield* threads.listProjectThreads({ projectId, includeSubagents: true })).length,
      0,
    );
    const ids = WorkerLaunch.workerLaunchIds(workerInput, "codex");
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: true } } },
      },
    });
    yield* threads.dispatch({
      type: "thread.create",
      ...ids,
      projectId,
      title: workerInput.title,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });
    const partial = yield* Effect.flatMap(WorkerLaunch.WorkerLaunch, (worker) =>
      worker.launch(workerInput),
    ).pipe(Effect.provide(workerLayer()), Effect.flip);
    assert.deepInclude(partial, { code: "provider_disabled" });
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    assert.isTrue(
      Option.isNone(
        yield* receipts.getByCommandId(CommandId.make(`${ids.commandId}:initial-message`)),
      ),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("worker reads the accepted initial run, never a later turn or an unknown command", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const worker = yield* WorkerLaunch.WorkerLaunch;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const missing = yield* worker.read({ commandId: workerInput.commandId }).pipe(Effect.flip);
    assert.equal(missing.code, "not_found");
    const receipt = yield* worker.launch(workerInput);
    const first = yield* worker.read({ commandId: workerInput.commandId });
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("later-command"),
      threadId: receipt.threadId,
      messageId: MessageId.make("later-message"),
      text: "A later independent turn",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* threads.getThreadProjection(receipt.threadId);
    assert.equal(projection.runs.length, 2);
    const read = yield* worker.read({ commandId: workerInput.commandId });
    assert.deepEqual(read.receipt, receipt);
    assert.equal(read.run.id, first.run.id);
    const ordinaryCommand = yield* worker
      .read({ commandId: CommandId.make("later-command") })
      .pipe(Effect.flip);
    assert.equal(ordinaryCommand.code, "not_found");
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const ids = WorkerLaunch.workerLaunchIds(workerInput, "codex");
    const initialMessage = yield* receipts.getByCommandId(
      CommandId.make(`${ids.commandId}:initial-message`),
    );
    assert.isTrue(Option.isSome(initialMessage));
    if (Option.isSome(initialMessage)) {
      yield* receipts.upsert({
        ...initialMessage.value,
        threadId: ThreadId.make("unrelated-thread"),
      });
      const inconsistent = yield* worker
        .read({ commandId: workerInput.commandId })
        .pipe(Effect.flip);
      assert.equal(inconsistent.code, "read_failed");
      const failedFollow = yield* worker
        .follow({ commandId: workerInput.commandId })
        .pipe(Stream.runHead, Effect.flip);
      assert.equal(failedFollow.code, "follow_failed");
    }
  }).pipe(Effect.provide(workerLayer().pipe(Layer.provideMerge(harness.layer))));
});

it.effect("worker follows its run across replay/live and resumes without later turns", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const worker = yield* WorkerLaunch.WorkerLaunch;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const missing = yield* worker
      .follow({ commandId: workerInput.commandId })
      .pipe(Stream.runHead, Effect.flip);
    assert.equal(missing.code, "not_found");
    const receipt = yield* worker.launch(workerInput);
    const original = yield* worker.read({ commandId: workerInput.commandId });
    const invalid = yield* worker
      .follow({ commandId: workerInput.commandId, afterSequence: Number.MAX_SAFE_INTEGER })
      .pipe(Stream.runHead, Effect.flip);
    assert.equal(invalid.code, "invalid_cursor");
    const first = yield* worker.follow({ commandId: workerInput.commandId }).pipe(Stream.runHead);
    assert.isTrue(Option.isSome(first));
    if (Option.isNone(first)) return;
    const firstSequence = first.value.sequence;
    const progress = yield* worker.follow({ commandId: workerInput.commandId }).pipe(
      Stream.tap((value) =>
        value.sequence !== firstSequence
          ? Effect.void
          : Effect.gen(function* () {
              yield* threads.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("follow-later-command"),
                threadId: receipt.threadId,
                messageId: MessageId.make("follow-later-message"),
                text: "Independent later turn",
                attachments: [],
                modelSelection,
                dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
                createdBy: "user",
                creationSource: "web",
              });
              yield* threads.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("follow-interrupt"),
                threadId: receipt.threadId,
                runId: original.run.id,
              });
            }),
      ),
      Stream.takeUntil((value) => value.execution.run.status === "interrupted"),
      Stream.runCollect,
    );
    assert.isAtLeast(progress.length, 2);
    assert.equal(progress[0]!.sequence, firstSequence);
    assert.equal(progress.at(-1)!.execution.run.status, "interrupted");
    assert.isTrue(progress.every((value) => value.execution.run.id === original.run.id));
    assert.isTrue(
      progress.every(
        (value, index) => index === 0 || value.sequence > progress[index - 1]!.sequence,
      ),
    );
    assert.deepEqual(progress[0]!.execution.receipt, receipt);
    assert.equal((yield* threads.getThreadProjection(receipt.threadId)).runs.length, 2);
    const resumed = yield* worker
      .follow({ commandId: workerInput.commandId, afterSequence: firstSequence })
      .pipe(Stream.take(progress.length - 1), Stream.runCollect);
    assert.deepEqual(resumed, progress.slice(1));
  }).pipe(Effect.provide(workerLayer().pipe(Layer.provideMerge(harness.layer))));
});

it.effect(
  "worker cancellation retries stay bound to the original run and acknowledge only a request",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = {
        commandId: CommandId.make("worker-cancel"),
        launchCommandId: workerInput.commandId,
      };
      const abandoned = {
        commandId: CommandId.make("cancel-before-delivery"),
        launchCommandId: CommandId.make("abandoned-launch"),
      };
      const missing = yield* worker.cancel(abandoned);
      assert.equal(missing.status, "not_started");
      assert.deepEqual(yield* worker.cancel(abandoned), missing);
      assert.equal(
        (yield* worker
          .launch({ ...workerInput, commandId: abandoned.launchCommandId })
          .pipe(Effect.flip)).code,
        "capacity_unavailable",
      );
      assert.equal(
        (yield* worker
          .cancel({ ...abandoned, launchCommandId: workerInput.commandId })
          .pipe(Effect.flip)).code,
        "command_conflict",
      );
      const launch = yield* worker.launch(workerInput);
      const original = yield* worker.read({ commandId: workerInput.commandId });
      const [first, concurrent] = yield* Effect.all([worker.cancel(input), worker.cancel(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(first, concurrent);
      assert.equal(first.status, "requested");
      if (first.status === "not_started") throw new Error("Expected accepted run cancellation");
      assert.equal(first.runId, original.run.id);
      assert.deepEqual(first.launch, launch);
      assert.equal(
        (yield* worker.read({ commandId: workerInput.commandId })).run.status,
        "interrupted",
      );
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cancel-later-command"),
        threadId: launch.threadId,
        messageId: MessageId.make("cancel-later-message"),
        text: "An independent later turn",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        createdBy: "user",
        creationSource: "web",
      });
      const beforeRetry = yield* threads.getThreadProjection(launch.threadId);
      const retry = yield* worker.cancel(input);
      assert.deepEqual(retry, first);
      const terminal = yield* worker.cancel({
        ...input,
        commandId: CommandId.make("new-cancel-terminal"),
      });
      assert.deepInclude(terminal, {
        status: "already_terminal",
        runStatus: "interrupted",
        runId: original.run.id,
      });
      const afterRetry = yield* threads.getThreadProjection(launch.threadId);
      assert.deepEqual(afterRetry.runs, beforeRetry.runs);
      assert.equal(
        afterRetry.turnItems.filter((item) => item.type === "run_interrupt_request").length,
        1,
      );
      const otherInput = { ...workerInput, commandId: CommandId.make("other-worker-launch") };
      const otherLaunch = yield* worker.launch(otherInput);
      yield* threads.streamStoredEventsFrom({ threadId: otherLaunch.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting",
        ),
        Stream.runHead,
      );
      const otherBefore = yield* worker.read({ commandId: otherInput.commandId });
      const conflict = yield* worker
        .cancel({ ...input, launchCommandId: otherInput.commandId })
        .pipe(Effect.flip);
      assert.equal(conflict.code, "command_conflict");
      assert.deepEqual(yield* worker.read({ commandId: otherInput.commandId }), otherBefore);
    }).pipe(
      Effect.provide(
        workerLayer(undefined, undefined, undefined, undefined, undefined, undefined, 2).pipe(
          Layer.provideMerge(harness.layer),
        ),
      ),
    );
  },
);

it.effect(
  "worker materializes required artifacts with new thread ownership before accepting a turn",
  () => {
    const harness = makeHarness();
    const bytes = new TextEncoder().encode("required result\n");
    const source: FoundryArtifactManifest = {
      reference: {
        instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
        artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
        owner: { environmentId: EnvironmentId.make("worker"), threadId: ThreadId.make("previous") },
      },
      name: "result.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: "a".repeat(64),
    };
    let mode = "unavailable";
    let downloads = 0;
    const publication = Layer.effect(
      ArtifactPublication.ArtifactPublication,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        return ArtifactPublication.ArtifactPublication.of({
          download: () => {
            downloads++;
            return mode === "unavailable"
              ? Effect.fail(new FoundryArtifactError({ code: "unavailable" }))
              : Effect.succeed({
                  manifest: mode === "changed" ? { ...source, sha256: "b".repeat(64) } : source,
                  bytes,
                });
          },
          publishAttachment: (threadId, attachment) =>
            Effect.gen(function* () {
              const target = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              assert.isNotNull(target);
              assert.deepEqual(yield* fs.readFile(target!), bytes);
              return {
                ...attachment,
                foundryArtifact: {
                  ...source,
                  reference: {
                    ...source.reference,
                    artifactId: FoundryArtifactId.make("33333333-3333-4333-8333-333333333333"),
                    owner: { ...source.reference.owner, threadId: ThreadId.make(threadId) },
                  },
                },
              };
            }).pipe(Effect.mapError(() => new FoundryArtifactError({ code: "unavailable" }))),
        });
      }),
    );
    const files = ServerConfig.layerTest(process.cwd(), {
      prefix: "worker-artifact-handoff-",
    }).pipe(Layer.provideMerge(NodeServices.layer));
    const workerFiles = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return {
          ...fs,
          realPath: (path: string) => (path === "/repo" ? Effect.succeed(path) : fs.realPath(path)),
        };
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    return Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const store = yield* ExecutionStore.ExecutionStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const input = {
        ...workerInput,
        commandId: CommandId.make("artifact-handoff"),
        inputArtifacts: [source],
      };
      assert.equal((yield* worker.launch(input).pipe(Effect.flip)).code, "handoff_unavailable");
      assert.isUndefined(yield* store.read(input.commandId));
      mode = "changed";
      assert.equal((yield* worker.launch(input).pipe(Effect.flip)).code, "handoff_changed");
      assert.isUndefined(yield* store.read(input.commandId));
      mode = "ready";
      const receipt = yield* worker.launch(input);
      const records = yield* threads.getThreadRecords(receipt.threadId, ["messages"]);
      const attachment = records.messages[0]?.attachments[0];
      assert.isDefined(attachment);
      assert.equal(attachment!.foundryArtifact?.reference.owner.threadId, receipt.threadId);
      assert.notEqual(
        attachment!.foundryArtifact?.reference.artifactId,
        source.reference.artifactId,
      );
      assert.deepEqual(
        yield* fs.readFile(
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: attachment!,
          })!,
        ),
        bytes,
      );
      const before = downloads;
      assert.deepEqual(yield* worker.launch(input), receipt);
      assert.equal(downloads, before);
      assert.equal(
        (yield* worker
          .launch({ ...input, inputArtifacts: [{ ...source, sha256: "b".repeat(64) }] })
          .pipe(Effect.flip)).code,
        "command_conflict",
      );
    }).pipe(
      Effect.provide(
        workerLayer(["/repo"], true, true, false, {}, workerFiles).pipe(
          Layer.provideMerge(harness.layer),
          Layer.provide(publication),
          Layer.provideMerge(files),
        ),
      ),
    );
  },
);

it.effect.each([
  "absent",
  "missing",
  "error",
  "stale",
  "missing-object",
  "ready",
  "other-workspace",
  "branch-workspace",
] as const)(
  "worker completion waits for writer evidence and a ready checkpoint with Git object: %s",
  (checkpointState) => {
    const harness = makeHarness();
    let handoffDiff = "";
    let captureFails = false;
    let checkpointAvailable = checkpointState !== "missing-object";
    const temporaryRefs = new Set<string>();
    let lastTemporaryRef: string | undefined;
    let diffCalls = 0;
    let changeAfterReservation = false;
    const bindings: WriterBinding[] = [];
    const released: string[] = [];
    const gate = Layer.succeed(WorkspaceGate, {
      handoffs: null,
      reconcile: Effect.void,
      installReconciler: () => Effect.void,
      prepare: () => Effect.succeed(true),
      starting: () => Effect.succeed(true),
      bindings: Effect.succeed(bindings),
      reserve: (input) =>
        Effect.sync(() => {
          bindings.push({
            requestId: input.commandId,
            commandId: input.commandId,
            threadId: input.threadId,
            generation: input.generation,
            runId: null,
            attemptId: null,
            closed: 0,
            verified: 0,
          });
          return checkpointState === "branch-workspace"
            ? {
                requestId: input.commandId,
                repositoryPath: input.repositoryPath,
                mode: input.mode,
                managedRoot: "/repo",
                workspacePath: input.repositoryPath,
                baseCommit: "base",
                branch: null,
                state: "ready" as const,
              }
            : null;
        }),
      confirm: (requestId) =>
        Effect.sync(() => {
          released.push(requestId);
        }),
    });
    return Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ExecutionStore.ExecutionStore;
      const receipt = yield* worker.launch(workerInput);
      const { runs } = yield* threads.getThreadRecords(receipt.threadId, ["runs"]);
      const run = runs[0]!;
      const now = yield* DateTime.now;
      const scopeId = CheckpointScopeId.make("worker-result-scope");
      const checkpointId = CheckpointId.make("worker-result-checkpoint");
      const nodeId = NodeId.make("worker-result-root");
      yield* sink.write({
        events: [
          {
            id: EventId.make("worker-done"),
            type: "run.updated",
            threadId: receipt.threadId,
            occurredAt: now,
            payload: {
              ...run,
              status: "completed",
              completedAt: now,
              checkpointId: checkpointState === "absent" ? null : checkpointId,
            },
          },
        ],
      });
      let result = yield* worker.read({ commandId: workerInput.commandId });
      assert.isFalse(result.lifecycle?.writerEnded);
      assert.isNull(result.lifecycle?.manifest);
      const row = yield* store.read(workerInput.commandId);
      yield* store.confirm(workerInput.commandId, row!.generation);
      result = yield* worker.read({ commandId: workerInput.commandId });
      assert.equal(result.lifecycle?.state, "finalizing");
      assert.isNull(result.lifecycle?.manifest);
      if (checkpointState !== "absent") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("worker-result-scope"),
              type: "checkpoint-scope.created",
              threadId: receipt.threadId,
              occurredAt: now,
              payload: {
                id: scopeId,
                threadId: receipt.threadId,
                runId: run.id,
                nodeId,
                parentScopeId: null,
                providerThreadId: null,
                kind: "root_run",
                ordinalWithinParent: 0,
                advancesAppRunCount: true,
                cwd:
                  checkpointState === "other-workspace"
                    ? "/other-repo"
                    : checkpointState === "branch-workspace"
                      ? "/repo/branch"
                      : "/repo",
                createdAt: now,
              },
            },
            {
              id: EventId.make("worker-result-captured"),
              type: "checkpoint.captured",
              threadId: receipt.threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId: receipt.threadId,
                scopeId,
                runId: run.id,
                nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 1,
                appRunOrdinal: 1,
                ref: CheckpointRef.make("refs/checkpoints/worker-result"),
                status:
                  checkpointState === "missing-object" ||
                  checkpointState === "other-workspace" ||
                  checkpointState === "branch-workspace"
                    ? "ready"
                    : checkpointState,
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
      }
      result = yield* worker.read({ commandId: workerInput.commandId });
      if (
        checkpointState === "ready" ||
        checkpointState === "other-workspace" ||
        checkpointState === "branch-workspace"
      ) {
        assert.equal(result.lifecycle?.state, "completed");
        assert.deepInclude(result.lifecycle?.manifest, {
          checkpointId,
          runId: run.id,
          outcome: "completed",
        });
        assert.deepEqual(yield* worker.read({ commandId: workerInput.commandId }), result);
        const next = {
          ...workerInput,
          commandId: CommandId.make("worker-handoff"),
          previousExecution: { commandId: workerInput.commandId, generation: row!.generation },
        };
        if (checkpointState === "other-workspace") {
          assert.equal((yield* worker.launch(next).pipe(Effect.flip)).code, "project_denied");
          assert.equal(temporaryRefs.size, 0);
          return;
        }
        for (const invalid of [
          {
            ...next,
            previousExecution: { ...next.previousExecution, generation: row!.generation + 1 },
          },
          { ...next, workspaceMode: "worktree" as const },
        ]) {
          assert.equal(
            (yield* worker
              .launch({
                ...invalid,
                commandId: CommandId.make(
                  `invalid-handoff-${invalid.previousExecution.generation}-${"workspaceMode" in invalid ? invalid.workspaceMode : "checkout"}`,
                ),
              })
              .pipe(Effect.flip)).code,
            "handoff_unavailable",
          );
        }
        checkpointAvailable = false;
        assert.equal((yield* worker.launch(next).pipe(Effect.flip)).code, "handoff_unavailable");
        checkpointAvailable = true;
        captureFails = true;
        assert.equal((yield* worker.launch(next).pipe(Effect.flip)).code, "handoff_unavailable");
        assert.equal(temporaryRefs.size, 0);
        captureFails = false;
        // Model a crash after capture: the retry must remove the pre-existing snapshot too.
        temporaryRefs.add(lastTemporaryRef!);
        handoffDiff = "modified working tree";
        assert.equal((yield* worker.launch(next).pipe(Effect.flip)).code, "handoff_changed");
        assert.equal(temporaryRefs.size, 0);
        handoffDiff = "";
        diffCalls = 0;
        changeAfterReservation = true;
        const raced = { ...next, commandId: CommandId.make("handoff-raced") };
        assert.equal((yield* worker.launch(raced).pipe(Effect.flip)).code, "handoff_changed");
        assert.deepEqual(released, [raced.commandId]);
        const fenced = yield* store.read(raced.commandId);
        assert.deepInclude(fenced, { stopRequested: 1, writerEnded: 1, manifest: null });
        changeAfterReservation = false;
        assert.equal((yield* worker.launch(raced).pipe(Effect.flip)).code, "launch_failed");
        assert.isFalse(
          yield* store.starting({
            threadId: fenced!.threadId,
            providerThreadId: ProviderThreadId.make("must-not-start"),
            runOrdinal: 1,
          }),
        );
        assert.equal(
          (yield* worker.read({ commandId: raced.commandId }).pipe(Effect.flip)).code,
          "not_found",
        );
        const nextReceipt = yield* worker.launch(next);
        assert.notEqual(nextReceipt.threadId, receipt.threadId);
        if (checkpointState === "branch-workspace")
          assert.equal(
            (yield* threads.getThreadRecords(nextReceipt.threadId, [])).thread.worktreePath,
            "/repo/branch",
          );
        assert.equal(temporaryRefs.size, 0);
        assert.deepEqual(yield* worker.launch(next), nextReceipt);
        assert.equal(
          (yield* worker
            .launch({
              ...next,
              previousExecution: { ...next.previousExecution, generation: row!.generation + 1 },
            })
            .pipe(Effect.flip)).code,
          "command_conflict",
        );
      } else {
        assert.equal(result.lifecycle?.state, "finalizing");
        assert.isNull(result.lifecycle?.manifest);
      }
    }).pipe(
      Effect.provide(
        workerLayer(["/repo"], true, true, checkpointState !== "missing-object", {
          hasCheckpointRef: () => Effect.succeed(checkpointAvailable),
          captureCheckpoint: ({ checkpointRef }) =>
            Effect.gen(function* () {
              temporaryRefs.add(checkpointRef);
              lastTemporaryRef = checkpointRef;
              if (captureFails)
                return yield* new VcsProcessExitError({
                  operation: "capture",
                  command: "git",
                  cwd: "/repo",
                  exitCode: 1,
                  detail: "fixture failure",
                });
            }),
          diffCheckpoints: () =>
            Effect.sync(() => {
              diffCalls++;
              return changeAfterReservation && diffCalls === 2
                ? "changed after reservation"
                : handoffDiff;
            }),
          deleteCheckpointRefs: ({ checkpointRefs }) =>
            Effect.sync(() => {
              for (const ref of checkpointRefs) temporaryRefs.delete(ref);
            }),
        }).pipe(Layer.provide(gate), Layer.provideMerge(harness.layer)),
      ),
    );
  },
);

it.effect(
  "worker releases an expired prelaunch reservation without inventing a completed run",
  () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<string>();
      const bindings: WriterBinding[] = [];
      const gate = Layer.succeed(WorkspaceGate, {
        handoffs: null,
        reconcile: Effect.void,
        installReconciler: () => Effect.void,
        prepare: () => Effect.succeed(true),
        starting: () => Effect.succeed(true),
        bindings: Effect.succeed(bindings),
        reserve: () => Effect.succeed(null),
        confirm: (requestId) => Deferred.succeed(released, requestId).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const worker = yield* WorkerLaunch.WorkerLaunch;
        const store = yield* ExecutionStore.ExecutionStore;
        const commandId = CommandId.make("crashed-before-thread");
        const threadId = ThreadId.make("foundry-launch:crashed-before-thread");
        const row = yield* store.reserve(commandId, threadId);
        bindings.push({
          requestId: "reservation-before-thread",
          commandId,
          threadId,
          generation: row.generation,
          runId: null,
          attemptId: null,
          closed: 0,
          verified: 0,
        });
        yield* TestClock.adjust("60 seconds");
        assert.equal(yield* Deferred.await(released), "reservation-before-thread");
        assert.deepInclude(yield* store.read(commandId), {
          writerEnded: 1,
          stopRequested: 1,
          manifest: null,
        });
        assert.equal((yield* worker.read({ commandId }).pipe(Effect.flip)).code, "not_found");
        assert.isFalse(
          yield* store.starting({
            threadId,
            providerThreadId: ProviderThreadId.make("forbidden-start"),
            runOrdinal: 1,
          }),
        );
      }).pipe(
        Effect.provide(
          workerLayer().pipe(Layer.provide(gate), Layer.provideMerge(makeHarness().layer)),
        ),
      );
    }),
);

it.effect("running worker cancel remains uncertain until confirmed writing end", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const worker = yield* WorkerLaunch.WorkerLaunch;
    const store = yield* ExecutionStore.ExecutionStore;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const receipt = yield* worker.launch(workerInput);
    const execution = yield* worker.read({ commandId: workerInput.commandId });
    const row = yield* store.read(workerInput.commandId);
    assert.isTrue(
      yield* store.starting({
        threadId: receipt.threadId,
        providerThreadId: ProviderThreadId.make("running-worker"),
        runOrdinal: 1,
      }),
    );
    yield* worker.cancel({
      commandId: CommandId.make("stop-running-worker"),
      launchCommandId: workerInput.commandId,
    });
    let stopped = yield* worker.read({ commandId: workerInput.commandId });
    assert.isFalse(stopped.lifecycle?.writerEnded);
    assert.isNull(stopped.lifecycle?.manifest);
    yield* store.confirm(workerInput.commandId, row!.generation);
    const { runs } = yield* threads.getThreadRecords(receipt.threadId, ["runs"]);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("worker-stop-confirmed"),
          type: "run.updated",
          threadId: receipt.threadId,
          occurredAt: now,
          payload: {
            ...runs.find((run) => run.id === execution.run.id)!,
            status: "interrupted",
            completedAt: now,
          },
        },
      ],
    });
    stopped = yield* worker.read({ commandId: workerInput.commandId });
    assert.equal(stopped.lifecycle?.state, "stopped");
    assert.deepInclude(stopped.lifecycle?.manifest, { outcome: "stopped", checkpointId: null });
  }).pipe(Effect.provide(workerLayer().pipe(Layer.provideMerge(harness.layer))));
});

it.effect(
  "worker watchdog interrupts only its original run after the controller stops renewing",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const worker = yield* WorkerLaunch.WorkerLaunch;
      const store = yield* ExecutionStore.ExecutionStore;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const receipt = yield* worker.launch(workerInput);
      const original = yield* worker.read({ commandId: workerInput.commandId });
      const row = yield* store.read(workerInput.commandId);
      yield* store.starting({
        threadId: receipt.threadId,
        providerThreadId: ProviderThreadId.make("partitioned-worker"),
        runOrdinal: 1,
      });
      const stopped = yield* threads
        .streamStoredEventsFrom({ threadId: receipt.threadId, afterSequence: receipt.sequence })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === original.run.id &&
              stored.event.payload.status === "interrupted",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
      yield* TestClock.adjust("60 seconds");
      assert.isTrue(Option.isSome(yield* Fiber.join(stopped)));
      const result = yield* worker.read({ commandId: workerInput.commandId });
      assert.isFalse(result.lifecycle?.writerEnded);
      assert.isNull(result.lifecycle?.manifest);
      assert.isFalse(yield* store.renew(workerInput.commandId, row!.generation));
      assert.deepEqual(yield* worker.launch(workerInput), receipt);
      assert.lengthOf((yield* threads.getThreadRecords(receipt.threadId, ["runs"])).runs, 1);
    }).pipe(Effect.provide(workerLayer().pipe(Layer.provideMerge(harness.layer))));
  },
);

it.live(
  "worker starts a returned branch only at the confirmed commit and keeps its receipt after lost acknowledgement",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const temp = yield* fs.makeTempDirectoryScoped();
      const cwd = `${temp}/returned`;
      yield* fs.makeDirectory(cwd);
      const execute = Effect.fn("test.returned.git")(function* (args: ReadonlyArray<string>) {
        return (yield* git.execute({ cwd, operation: "test.returned", args })).stdout.trim();
      });
      yield* execute(["init"]);
      yield* fs.writeFileString(`${cwd}/result.txt`, "returned");
      yield* execute(["add", "."]);
      yield* execute([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "result",
      ]);
      const commitSha = yield* execute(["rev-parse", "HEAD"]);
      const treeSha = yield* execute(["rev-parse", "HEAD^{tree}"]);
      const result = {
        receipt: {
          handoffId: "interactive",
          threadId: ThreadId.make("interactive-thread"),
          projectId,
          workspacePath: cwd,
          branch: "result",
          baseCommit: commitSha,
          baseCheckpointRef: commitSha,
          sourceThreadId: ThreadId.make("source"),
          mode: "branch" as const,
        },
        commitSha,
        treeSha,
        checkpointRef: commitSha,
        bundle: {
          reference: {
            instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
            artifactId: FoundryArtifactId.make("22222222-2222-4222-8222-222222222222"),
            owner: {
              environmentId: EnvironmentId.make("worker"),
              threadId: ThreadId.make("interactive-thread"),
            },
          },
          name: "result.bundle",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
          sha256: "a".repeat(64),
        },
        archive: {
          instanceId: FoundryInstanceId.make("11111111-1111-4111-8111-111111111111"),
          deviceId: FoundryDeviceId.make("33333333-3333-4333-8333-333333333333"),
          deviceGeneration: 1,
          owner: {
            environmentId: EnvironmentId.make("worker"),
            threadId: ThreadId.make("interactive-thread"),
          },
          cursor: 1,
          sourceSequence: 1,
        },
        tests: "manual",
        openPoints: "",
      };
      const encoded = yield* encodeHandoffResult(result);
      const journal = ReservationStore.layer(`${temp}/journal.sqlite`);
      const gate = Layer.effect(
        WorkspaceGate,
        Effect.gen(function* () {
          const store = yield* ReservationStore.ReservationStore;
          return WorkspaceGate.of({
            handoffs: store,
            reconcile: Effect.void,
            installReconciler: () => Effect.void,
            prepare: () => Effect.succeed(true),
            starting: () => Effect.succeed(true),
            bindings: store.bindings,
            confirm: (id) => store.setState(id, "released"),
            reserve: Effect.fn("test.returned.reserve")(function* (input) {
              const reservation = {
                requestId: input.commandId,
                repositoryPath: input.repositoryPath,
                workspacePath: input.repositoryPath,
                managedRoot: temp,
                mode: input.mode,
                baseCommit: commitSha,
                branch: "result",
                state: "ready" as const,
              };
              if (!(yield* store.claim(reservation, input.threadId)))
                return yield* new FoundryWorkspaceError({ code: "writer_busy" });
              return reservation;
            }),
          });
        }),
      ).pipe(Layer.provideMerge(journal));
      yield* Effect.gen(function* () {
        const worker = yield* WorkerLaunch.WorkerLaunch;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const store = yield* ReservationStore.ReservationStore;
        yield* store.hold({
          id: "interactive",
          threadId: result.receipt.threadId,
          workspacePath: cwd,
          state: "open",
          payload: "request",
          receipt: null,
          result: encoded,
          closingCommand: null,
        });
        const input = {
          ...workerInput,
          commandId: CommandId.make("returned-launch"),
          previousHandoff: { handoffId: "interactive", commitSha },
        };
        assert.equal((yield* worker.launch(input).pipe(Effect.flip)).code, "handoff_unavailable");
        yield* store.transitionHandoff("interactive", "open", "returned");
        assert.equal(
          (yield* worker
            .launch({
              ...input,
              previousHandoff: { ...input.previousHandoff, commitSha: "a".repeat(40) },
            })
            .pipe(Effect.flip)).code,
          "handoff_changed",
        );
        const receipt = yield* worker.launch(input);
        assert.equal(
          (yield* threads.getThreadRecords(receipt.threadId, [])).thread.worktreePath,
          cwd,
        );
        yield* execute([
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "later",
        ]);
        assert.deepEqual(yield* worker.launch(input), receipt);
        assert.equal(
          (yield* worker
            .launch({ ...input, commandId: CommandId.make("changed-head") })
            .pipe(Effect.flip)).code,
          "handoff_changed",
        );
        assert.equal((yield* threads.getThreadRecords(receipt.threadId, ["runs"])).runs.length, 1);
      }).pipe(
        Effect.provide(
          workerLayer([temp], true, true, true, {}, NodeServices.layer).pipe(
            Layer.provideMerge(gate),
            Layer.provideMerge(harness.layer),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "returned-worker-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);
