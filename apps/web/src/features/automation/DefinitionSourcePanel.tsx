import { useState } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AutomationApplicationCommand,
  EnvironmentId,
  FactoryDefinitionFiles,
  FactoryDefinitionSourceBinding,
  FactoryDefinitionVersion,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { automationCommands } from "./commands";
import { isDefinitiveAutomationFailure } from "./failures";
import { useAutomationQuery } from "./useAutomationQuery";

type SourceCommand = Extract<
  AutomationApplicationCommand,
  {
    op:
      | "configureDefinitionSource"
      | "syncDefinitionSource"
      | "setDefinitionSourceEnabled"
      | "activateDefinitionRevision";
  }
>;

export function DefinitionSourcePanel({
  environmentId,
  factoryId,
  scopeVersionId,
  active,
  binding,
  onChanged,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  scopeVersionId: string;
  active: FactoryDefinitionVersion | null;
  binding: FactoryDefinitionSourceBinding | null;
  onChanged: () => void;
}) {
  const [repository, setRepository] = useState("niklaskastning/foundry-definitions");
  const [repositoryId, setRepositoryId] = useState("1444110572");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState(factoryId);
  const [after, setAfter] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<SourceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const revisions = useAutomationQuery(environmentId, {
    op: "definitionRevisions",
    factoryId,
    limit: 20,
    ...(after ? { after } : {}),
  });
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const canConfigure = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "configureDefinitionSource" }),
  );
  const canSync = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "syncDefinitionSource" }),
  );
  const canEnable = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "setDefinitionSourceEnabled" }),
  );
  const canActivate = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "activateDefinitionRevision" }),
  );
  const permissions = {
    configureDefinitionSource: canConfigure,
    syncDefinitionSource: canSync,
    setDefinitionSourceEnabled: canEnable,
    activateDefinitionRevision: canActivate,
  };
  const page = revisions.result?.kind === "definitionRevisions" ? revisions.result : null;
  const locked = busy || pending !== null;
  function refresh() {
    revisions.refresh();
    onChanged();
  }
  async function submit(input: SourceCommand) {
    if (busy || !permissions[input.op]) return;
    setPending(input);
    setBusy(true);
    const response = await command({ environmentId, input });
    setBusy(false);
    if (AsyncResult.isSuccess(response)) {
      setPending(null);
      setFailed(false);
      setMessage(
        input.op === "activateDefinitionRevision"
          ? "Revision activated. Existing runs keep their pinned definition."
          : input.op === "syncDefinitionSource" || input.op === "configureDefinitionSource"
            ? "Source saved; synchronization is queued. Refresh to see the read revision. Activation remains a separate decision."
            : "Source authorization saved. No revision was activated.",
      );
      refresh();
    } else {
      const failure = squashAtomCommandFailure(response);
      const definitive = isDefinitiveAutomationFailure(failure);
      if (definitive) setPending(null);
      setFailed(true);
      setMessage(
        `${failure instanceof Error ? failure.message : "Source operation failed."} Check GitHub App access and source status. For a conflict, refresh and compare the active version and import basis before trying again. ${definitive ? "No new activation is confirmed." : "The outcome is unconfirmed; retry the same request before another action."}`,
      );
      refresh();
    }
  }
  return (
    <section aria-label="Git definition source" className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Git definition source</h2>
        <Button variant="outline" onClick={refresh}>
          Refresh source and revisions
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Definitions live in a separate GitHub repository. Synchronization reads revisions; only an
        explicit activation changes the definition used by new runs.
      </p>
      {binding ? (
        <>
          <dl className="space-y-2 break-all text-sm">
            <div>
              <dt className="font-medium">Repository</dt>
              <dd>
                <a
                  className="underline"
                  href={`https://github.com/${binding.repository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {binding.repository}
                </a>{" "}
                · ID {binding.repositoryId}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Branch / directory</dt>
              <dd>
                {binding.branch} · {binding.path || "/"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Source status</dt>
              <dd>
                {binding.status} ·{" "}
                {binding.enabled ? "Background reads authorized" : "Background reads paused"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Active commit</dt>
              <dd>
                {active?.source.kind === "github" ? (
                  <CommitLink repository={active.source.repository} sha={active.source.commitSha} />
                ) : (
                  "No active Git revision"
                )}
              </dd>
            </div>
          </dl>
          {binding.selectedRevisionId ? (
            <ReadRevision
              key={binding.selectedRevisionId}
              environmentId={environmentId}
              factoryId={factoryId}
              revisionId={binding.selectedRevisionId}
              repository={binding.repository}
            />
          ) : (
            <p className="text-sm">No revision read yet.</p>
          )}
          {binding.error ? (
            <p role="alert" className="whitespace-pre-wrap text-sm">
              Synchronization: {binding.error}. Check the repository, branch, definition files and
              GitHub App contents permission, then authorize or sync again.
            </p>
          ) : null}
          {binding.ownership === "pending" ? (
            <div className="space-y-1 rounded border p-3 text-sm">
              <p className="font-medium">Pending import: local definition remains active</p>
              <p>
                Activation transfers ownership to Git only when the repository matches the recorded
                local import basis. Local edits after binding cause a drift conflict.
              </p>
              <Button
                variant="outline"
                disabled={locked || !canConfigure}
                onClick={() =>
                  void submit({
                    op: "configureDefinitionSource",
                    commandId: randomUUID(),
                    factoryId,
                    scopeVersionId: binding.scopeVersionId,
                    expectedGeneration: binding.generation,
                    expectedVersionId: active?.id ?? null,
                    expectedContentHash: active?.contentHash ?? null,
                    location: {
                      connectionId: binding.connectionId,
                      repositoryId: binding.repositoryId,
                      repository: binding.repository,
                      branch: binding.branch,
                      path: binding.path,
                    },
                  })
                }
              >
                Use current local version as import basis
              </Button>
              <p className="break-all">
                Import version: {binding.importVersionId ?? "New factory"}
              </p>
              <p className="break-all">
                Import content hash: {binding.importContentHash ?? "No existing definition"}
              </p>
              {active &&
              (active.id !== binding.importVersionId ||
                active.contentHash !== binding.importContentHash) ? (
                <p role="alert">
                  The active local definition has changed since binding. Import is blocked by drift;
                  review the local changes and explicitly update the import basis before importing.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm">
              Git owns this definition. Contents are read-only here; propose changes through commits
              or pull requests in the definitions repository. Pausing reads does not restore local
              editing.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={locked || !canSync || !binding.enabled}
              onClick={() =>
                void submit({
                  op: "syncDefinitionSource",
                  commandId: randomUUID(),
                  factoryId,
                  expectedGeneration: binding.generation,
                })
              }
            >
              Sync now
            </Button>
            <Button
              variant="outline"
              disabled={locked || !canEnable}
              onClick={() =>
                void submit({
                  op: "setDefinitionSourceEnabled",
                  commandId: randomUUID(),
                  factoryId,
                  expectedGeneration: binding.generation,
                  enabled: true,
                })
              }
            >
              {binding.enabled ? "Reauthorize source" : "Authorize background reads"}
            </Button>
            <Button
              variant="outline"
              disabled={locked || !canEnable || !binding.enabled}
              onClick={() =>
                void submit({
                  op: "setDefinitionSourceEnabled",
                  commandId: randomUUID(),
                  factoryId,
                  expectedGeneration: binding.generation,
                  enabled: false,
                })
              }
            >
              Pause background reads
            </Button>
          </div>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (locked || !canConfigure) return;
            void submit({
              op: "configureDefinitionSource",
              commandId: randomUUID(),
              factoryId,
              scopeVersionId,
              expectedVersionId: active?.id ?? null,
              expectedContentHash: active?.contentHash ?? null,
              location: {
                connectionId: "github-app",
                repositoryId: Number(repositoryId),
                repository: repository.trim(),
                branch: branch.trim(),
                path: path.trim(),
              },
            });
          }}
        >
          <fieldset disabled={locked || !canConfigure} className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-sm">Definitions repository (owner/name)</span>
              <Input
                required
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm">GitHub repository ID</span>
              <Input
                required
                type="number"
                min="1"
                step="1"
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm">Branch</span>
              <Input required value={branch} onChange={(event) => setBranch(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-sm">Definition directory (empty for root)</span>
              <Input value={path} onChange={(event) => setPath(event.target.value)} />
            </label>
          </fieldset>
          <p className="text-sm">
            This permanent location cannot be changed here. Binding authorizes background reads and
            records{" "}
            {active
              ? `active version ${active.id} as the import basis`
              : "an empty import basis for this new factory"}
            . Review a revision before explicitly transferring ownership.
          </p>
          <Button type="submit" disabled={locked || !canConfigure || !scopeVersionId}>
            Bind definitions repository
          </Button>
        </form>
      )}
      {pending && !busy ? (
        <Button
          variant="outline"
          disabled={!permissions[pending.op]}
          onClick={() => void submit(pending)}
        >
          Retry unconfirmed source request
        </Button>
      ) : null}
      {message ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {message}
        </p>
      ) : null}
      {binding ? (
        <>
          <h3 className="font-medium">Read revisions</h3>
          {revisions.error ? <p role="alert">{revisions.error}</p> : null}
          {revisions.loading ? <p role="status">Loading revisions…</p> : null}
          <ul className="divide-y">
            {page?.items.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span>
                  <CommitLink repository={binding.repository} sha={revision.commitSha} /> ·{" "}
                  {revision.valid ? "Valid" : "Invalid"}
                  {active?.source.kind === "github" && active.source.reference === revision.id
                    ? " · Active"
                    : ""}{" "}
                  · {new Date(revision.createdAt).toLocaleString()}
                </span>
                <Button variant="outline" onClick={() => setSelected(revision.id)}>
                  Review revision {revision.commitSha.slice(0, 7)}
                </Button>
              </li>
            ))}
          </ul>
          {page?.items.length === 0 ? (
            <p className="text-sm">No revisions yet. Sync and refresh to read the repository.</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!after || revisions.loading}
              onClick={() => setAfter(undefined)}
            >
              First revisions
            </Button>
            <Button
              variant="outline"
              disabled={!page?.next || revisions.loading}
              onClick={() => setAfter(page?.next ?? undefined)}
            >
              Next revisions
            </Button>
          </div>
          {selected ? (
            <RevisionDetail
              key={`${selected}:${active?.id ?? "none"}:${binding.generation}`}
              environmentId={environmentId}
              factoryId={factoryId}
              revisionId={selected}
              binding={binding}
              active={active}
              disabled={locked || !canActivate}
              onActivate={() =>
                void submit({
                  op: "activateDefinitionRevision",
                  commandId: randomUUID(),
                  factoryId,
                  revisionId: selected,
                  expectedGeneration: binding.generation,
                  expectedVersionId: active?.id ?? null,
                })
              }
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CommitLink({ repository, sha }: { repository: string; sha: string }) {
  return (
    <a
      className="break-all underline"
      href={`https://github.com/${repository}/commit/${sha}`}
      target="_blank"
      rel="noreferrer"
    >
      {sha}
    </a>
  );
}

function ReadRevision({
  environmentId,
  factoryId,
  revisionId,
  repository,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  revisionId: string;
  repository: string;
}) {
  const { result, error } = useAutomationQuery(environmentId, {
    op: "definitionRevision",
    factoryId,
    revisionId,
  });
  return (
    <div className="text-sm">
      Read commit:{" "}
      {result?.kind === "definitionRevision" ? (
        <CommitLink repository={repository} sha={result.revision.commitSha} />
      ) : error ? (
        <span role="alert">{error}</span>
      ) : (
        "Loading…"
      )}
    </div>
  );
}

function RevisionDetail({
  environmentId,
  factoryId,
  revisionId,
  binding,
  active,
  disabled,
  onActivate,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  revisionId: string;
  binding: FactoryDefinitionSourceBinding;
  active: FactoryDefinitionVersion | null;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { result, error, loading, refresh } = useAutomationQuery(environmentId, {
    op: "definitionRevision",
    factoryId,
    revisionId,
  });
  const detail = result?.kind === "definitionRevision" ? result : null;
  const isActive = active?.source.kind === "github" && active.source.reference === revisionId;
  const importDrift =
    binding.ownership === "pending" &&
    ((active?.id ?? null) !== binding.importVersionId ||
      (active?.contentHash ?? null) !== binding.importContentHash ||
      (binding.importContentHash !== null &&
        detail?.revision.contentHash !== binding.importContentHash));
  return (
    <section aria-label="Definition revision details" className="space-y-3 rounded border p-3">
      <h3 className="font-medium">Review revision</h3>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">Loading revision…</p> : null}
      <Button variant="outline" onClick={refresh}>
        Refresh comparison
      </Button>
      {detail ? (
        <>
          <p className="text-sm">
            <CommitLink repository={binding.repository} sha={detail.revision.commitSha} /> ·{" "}
            {detail.revision.valid ? "Valid" : "Invalid"}
          </p>
          {detail.revision.issues.length ? (
            <ul className="list-inside list-disc text-sm" aria-label="Validation issues">
              {detail.revision.issues.map((issue) => (
                <li key={[issue.file, ...issue.path, issue.message].join(":")}>
                  {issue.file} · {issue.path.join(".")}: {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <RevisionFiles
            environmentId={environmentId}
            factoryId={factoryId}
            revisionId={revisionId}
            files={detail.files}
            activeFiles={detail.activeFiles}
            activeVersionId={detail.activeVersionId}
          />
          {importDrift ? (
            <p role="alert" className="text-sm">
              Import drift: this revision or the active definition differs from the recorded import
              basis. No ownership transfer is possible until the basis matches.
            </p>
          ) : null}
          <p className="text-sm">
            Activating a previously read valid revision rolls back the definition for new runs.
            Existing runs retain their pinned version. No run starts automatically.
          </p>
          <Button
            disabled={
              disabled ||
              loading ||
              Boolean(error) ||
              !binding.enabled ||
              !detail.revision.valid ||
              isActive ||
              importDrift
            }
            onClick={onActivate}
          >
            {isActive
              ? "Already active"
              : binding.ownership === "pending"
                ? "Import revision and transfer ownership to Git"
                : "Activate this revision / roll back"}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function RevisionFiles({
  environmentId,
  factoryId,
  revisionId,
  files,
  activeFiles,
  activeVersionId,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  revisionId: string;
  files: readonly string[];
  activeFiles: readonly string[] | null;
  activeVersionId: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const paths = [...new Set([...files, ...(activeFiles ?? [])])].sort();
  const path = selected ?? paths[0];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {paths.map((item) => (
          <Button
            key={item}
            variant={path === item ? "default" : "outline"}
            onClick={() => setSelected(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      {path ? (
        <RevisionFile
          key={`${revisionId}:${activeVersionId}:${path}`}
          environmentId={environmentId}
          factoryId={factoryId}
          revisionId={revisionId}
          path={path}
          activeVersionId={activeVersionId}
        />
      ) : null}
    </div>
  );
}
function RevisionFile({
  environmentId,
  ...input
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  revisionId: string;
  path: string;
  activeVersionId: string | null;
}) {
  const candidate = useAutomationQuery(environmentId, {
    op: "definitionRevisionFile",
    ...input,
    side: "revision",
  });
  const active = useAutomationQuery(environmentId, {
    op: "definitionRevisionFile",
    ...input,
    side: "active",
  });
  if (candidate.error || active.error) return <p role="alert">{candidate.error ?? active.error}</p>;
  if (candidate.loading || active.loading) return <p role="status">Loading file comparison…</p>;
  if (
    candidate.result?.kind !== "definitionRevisionFile" ||
    active.result?.kind !== "definitionRevisionFile"
  )
    return null;
  return (
    <FileComparison
      files={candidate.result.file ? [candidate.result.file] : []}
      activeFiles={active.result.file ? [active.result.file] : input.activeVersionId ? [] : null}
    />
  );
}

function FileComparison({
  files,
  activeFiles,
}: {
  files: FactoryDefinitionFiles;
  activeFiles: FactoryDefinitionFiles | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const theme = useRenderedAppearance();
  const paths = [
    ...new Set([
      ...(activeFiles ?? []).map((file) => file.path),
      ...files.map((file) => file.path),
    ]),
  ].sort();
  const path = selectedPath ?? paths[0];
  const before = activeFiles?.find((file) => file.path === path);
  const after = files.find((file) => file.path === path);
  const diff =
    path && before?.content !== after?.content
      ? parseDiffFromFile(
          { name: path, contents: before?.content ?? "" },
          { name: path, contents: after?.content ?? "" },
        )
      : null;
  return (
    <div className="space-y-3">
      <h4 className="font-medium">Files and diff against active definition</h4>
      {!activeFiles ? (
        <p className="text-sm">No active definition; all candidate files are additions.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {paths.map((filePath) => {
          const previous = activeFiles?.find((file) => file.path === filePath);
          const candidate = files.find((file) => file.path === filePath);
          const status = !previous
            ? "Added"
            : !candidate
              ? "Deleted"
              : previous.content === candidate.content
                ? "Unchanged"
                : "Modified";
          return (
            <Button
              key={filePath}
              variant={path === filePath ? "default" : "outline"}
              onClick={() => setSelectedPath(filePath)}
            >
              {filePath} · {status}
            </Button>
          );
        })}
      </div>
      {diff ? (
        <div
          className="max-h-96 overflow-auto rounded border"
          aria-label="Changes against active definition"
        >
          <FileDiff
            fileDiff={diff}
            options={{
              diffStyle: "unified",
              theme: resolveDiffThemeName(theme),
              overflow: "wrap",
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
            }}
          />
        </div>
      ) : (
        <p className="text-sm">This file matches the active definition.</p>
      )}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <div className="min-w-0">
          <h5 className="text-sm font-medium">Active · {path}</h5>
          <pre
            tabIndex={0}
            aria-label="Active file contents"
            className="max-h-96 overflow-auto rounded border p-3 text-xs"
          >
            {before?.content ?? "File absent"}
          </pre>
        </div>
        <div className="min-w-0">
          <h5 className="text-sm font-medium">Candidate · {path}</h5>
          <pre
            tabIndex={0}
            aria-label="Candidate file contents"
            className="max-h-96 overflow-auto rounded border p-3 text-xs"
          >
            {after?.content ?? "File absent"}
          </pre>
        </div>
      </div>
    </div>
  );
}
