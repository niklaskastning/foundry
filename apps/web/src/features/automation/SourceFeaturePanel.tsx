import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { automationCommands } from "./commands";
import { useAutomationQuery } from "./useAutomationQuery";

export function SourceFeaturePanel({
  environmentId,
  factoryId,
  runId,
}: {
  environmentId: EnvironmentId;
  factoryId: string;
  runId?: string;
}) {
  const factory = useAutomationQuery(environmentId, { op: "factory", factoryId });
  const revisions = useAutomationQuery(environmentId, {
    op: "definitionRevisions",
    factoryId,
    limit: 50,
  });
  const source = useAutomationQuery(environmentId, { op: "definitionSource", factoryId });
  const detail = factory.result?.kind === "factory" ? factory.result : null;
  const binding = source.result?.kind === "definitionSource" ? source.result.binding : null;
  const [repository, setRepository] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [branch, setBranch] = useState("main");
  const [commitSha, setCommitSha] = useState("");
  const [path, setPath] = useState(factoryId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const command = useAtomCommand(automationCommands.command, { reportFailure: false });
  const allowed = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "configureDefinitionSource" }),
  );
  const canActivate = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "activateDefinitionRevision" }),
  );
  const canEnable = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "setDefinitionSourceEnabled" }),
  );
  const canSync = useAtomValue(
    automationCommands.command.permissionAtom(environmentId, { op: "syncDefinitionSource" }),
  );
  const refresh = () => {
    factory.refresh();
    source.refresh();
    revisions.refresh();
  };
  if (factory.error || source.error) return <p role="alert">{factory.error ?? source.error}</p>;
  if (!detail || source.loading) return <p role="status">Loading definition source…</p>;
  const scopeVersionId =
    binding?.scopeVersionId ?? detail.active?.scopeVersionId ?? detail.versions[0]?.id;
  return (
    <section className="space-y-4" aria-label="Definition source configuration">
      <p>
        {detail.active?.definition.schemaVersion === 4
          ? (detail.active.definition.name ?? factoryId)
          : factoryId}
      </p>
      <p className="text-sm text-muted-foreground">
        {binding?.ownership === "git"
          ? "Git manages definitions and trigger configuration."
          : "Local definitions remain editable until explicit Git adoption."}{" "}
        {runId
          ? `Run ${runId} keeps its immutable definition pin.`
          : "Existing runs keep their immutable definition pins."}
      </p>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!allowed || busy || !scopeVersionId) return;
          setBusy(true);
          const response = await command({
            environmentId,
            input: {
              op: "configureDefinitionSource",
              commandId: randomUUID(),
              factoryId,
              scopeVersionId,
              ...(binding ? { expectedGeneration: binding.generation } : {}),
              expectedVersionId: detail.active?.id ?? null,
              expectedContentHash: detail.active?.contentHash ?? null,
              location: {
                connectionId: "github-app",
                repository: repository || binding?.repository || "",
                repositoryId: Number(repositoryId || binding?.repositoryId),
                branch: branch.trim() || "main",
                path: path.trim(),
                ...(commitSha ? { commitSha: commitSha.trim() } : {}),
              },
            },
          });
          setBusy(false);
          setMessage(
            AsyncResult.isSuccess(response)
              ? "Source saved. Sync and validation do not activate a revision."
              : "Source change unconfirmed. Refresh before retrying.",
          );
          refresh();
        }}
      >
        <fieldset disabled={busy || !allowed} className="grid gap-3 sm:grid-cols-2">
          <label>
            Repository
            <Input
              placeholder={binding?.repository ?? "owner/repository"}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
          </label>
          <label>
            Repository ID
            <Input
              type="number"
              min="1"
              placeholder={String(binding?.repositoryId ?? "")}
              value={repositoryId}
              onChange={(e) => setRepositoryId(e.target.value)}
            />
          </label>
          <label>
            Branch
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label>
            Exact commit (optional)
            <Input
              pattern="[a-f0-9]{40}"
              value={commitSha}
              onChange={(e) => setCommitSha(e.target.value)}
            />
          </label>
          <label>
            Definition directory
            <Input value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
        </fieldset>
        <Button type="submit" disabled={busy || !allowed || !scopeVersionId}>
          Save source for synchronization
        </Button>
      </form>
      {message ? <p role="status">{message}</p> : null}
      {binding && scopeVersionId ? (
        <>
          <p className="text-sm">
            Effective source: {binding.repository} · {binding.commitSha ?? binding.branch} ·{" "}
            {binding.path || "/"}
          </p>
          <p>
            Source status: {binding.status}
            {binding.error ? ` · ${binding.error}` : ""}
          </p>
          <p>
            Active for new runs:{" "}
            {detail.active?.source.kind === "github"
              ? detail.active.source.commitSha
              : "Local definition"}
          </p>
          <Button
            disabled={busy || !canSync || !binding.enabled}
            onClick={async () => {
              setBusy(true);
              const response = await command({
                environmentId,
                input: {
                  op: "syncDefinitionSource",
                  commandId: randomUUID(),
                  factoryId,
                  expectedGeneration: binding.generation,
                },
              });
              setBusy(false);
              setMessage(
                AsyncResult.isSuccess(response)
                  ? "Synchronization queued. Refresh to review validation; nothing was activated."
                  : "Sync outcome unconfirmed. Refresh source status.",
              );
              refresh();
            }}
          >
            Sync and validate
          </Button>
          <Button variant="outline" onClick={refresh}>
            Refresh revisions
          </Button>
          <Button
            variant="outline"
            disabled={busy || !canEnable}
            onClick={async () => {
              setBusy(true);
              const response = await command({
                environmentId,
                input: {
                  op: "setDefinitionSourceEnabled",
                  commandId: randomUUID(),
                  factoryId,
                  expectedGeneration: binding.generation,
                  enabled: !binding.enabled,
                },
              });
              setBusy(false);
              setMessage(
                AsyncResult.isSuccess(response)
                  ? "Background source access updated. No definition was activated."
                  : "Access change unconfirmed. Refresh source status.",
              );
              refresh();
            }}
          >
            {binding.enabled ? "Pause background reads" : "Authorize background reads"}
          </Button>
          {detail.active?.definition.schemaVersion === 4 &&
          detail.active.definition.triggers?.length ? (
            <div>
              <p>Git trigger configuration</p>
              <ul>
                {detail.active.definition.triggers.map((trigger) => (
                  <li key={trigger.id}>
                    {trigger.name} · {trigger.workflow} · {trigger.source.kind}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                Edit trigger configuration in Git. Runtime activation requires separate
                authorization.
              </p>
            </div>
          ) : null}
          {revisions.error ? <p role="alert">{revisions.error}</p> : null}
          <ul className="space-y-3">
            {revisions.result?.kind === "definitionRevisions"
              ? revisions.result.items.map((revision) => (
                  <li key={revision.id} className="space-y-2 border-t pt-3">
                    <p className="break-all">
                      {revision.commitSha} ·{" "}
                      {revision.valid ? "Valid candidate" : "Invalid candidate"}
                    </p>
                    <p>
                      {revision.location
                        ? `${revision.location.repository} · ${revision.location.branch} · ${revision.location.path || "/"}`
                        : "Historical source provenance unknown. Sync again before activation."}
                    </p>
                    {revision.issues.map((issue, index) => (
                      <p key={index} role="alert">
                        {issue.file}: {issue.path.join(".")} · {issue.message}
                      </p>
                    ))}
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        !canActivate ||
                        !binding.enabled ||
                        !revision.valid ||
                        !revision.location ||
                        (detail.active?.source.kind === "github" &&
                          detail.active.source.reference === revision.id)
                      }
                      onClick={async () => {
                        setBusy(true);
                        const response = await command({
                          environmentId,
                          input: {
                            op: "activateDefinitionRevision",
                            commandId: randomUUID(),
                            factoryId,
                            expectedGeneration: binding.generation,
                            expectedVersionId: detail.active?.id ?? null,
                            revisionId: revision.id,
                          },
                        });
                        setBusy(false);
                        setMessage(
                          AsyncResult.isSuccess(response)
                            ? "Revision activated for new runs. Existing runs retain their pins. Git triggers require separate runtime authorization."
                            : "Activation unconfirmed. Refresh and check the import basis and generation before retrying.",
                        );
                        refresh();
                      }}
                    >
                      Activate revision for new runs
                    </Button>
                  </li>
                ))
              : null}
          </ul>
        </>
      ) : null}
    </section>
  );
}
