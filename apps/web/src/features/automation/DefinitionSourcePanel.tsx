import { FoundryUI } from "../../foundry/FoundryUI";
import { factoryDefinitionPreview } from "@t3tools/shared/factoryDefinitionPreview";
import { useState } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import type { EnvironmentId, FactoryDefinitionFiles } from "@t3tools/contracts";
import { Button } from "../../components/ui/button";
import { useAutomationQuery } from "./useAutomationQuery";

export function DefinitionRevisionComparison({
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
  if (candidate.error || active.error)
    return <FoundryUI.Notice>{candidate.error ?? active.error}</FoundryUI.Notice>;
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
  files: ReadonlyArray<FactoryDefinitionFiles[number] & { readonly size?: number | undefined }>;
  activeFiles: ReadonlyArray<
    FactoryDefinitionFiles[number] & { readonly size?: number | undefined }
  > | null;
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
  const beforeFile = activeFiles?.find((file) => file.path === path);
  const afterFile = files.find((file) => file.path === path);
  const before = beforeFile ? factoryDefinitionPreview(beforeFile) : undefined;
  const after = afterFile ? factoryDefinitionPreview(afterFile) : undefined;
  const diff =
    path &&
    before?.encoding !== "base64" &&
    after?.encoding !== "base64" &&
    before?.content !== after?.content
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
              : previous.sha256 === candidate.sha256 &&
                  previous.content === candidate.content &&
                  previous.mode === candidate.mode &&
                  previous.encoding === candidate.encoding
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
        <p className="text-sm">
          {before?.sha256 === after?.sha256 &&
          before?.content === after?.content &&
          before?.mode === after?.mode &&
          before?.encoding === after?.encoding
            ? "This file matches the active definition."
            : "Binary content or file mode changed. Review the pinned hashes and modes below."}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">View file contents and metadata</summary>
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          {before?.sha256 !== after?.sha256 ||
          before?.content !== after?.content ||
          before?.mode !== after?.mode ||
          before?.encoding !== after?.encoding ? (
            <div className="min-w-0">
              <h5 className="text-sm font-medium">Active · {path}</h5>
              <pre
                tabIndex={0}
                aria-label="Active file contents"
                className="max-h-96 overflow-auto rounded border p-3 text-xs"
              >
                {before
                  ? before.encoding === "base64"
                    ? `Binary file · SHA-256 ${before.sha256} · mode ${before.mode} · ${before.size} bytes`
                    : `${before.mode ? `Mode ${before.mode}\n` : ""}${before.content}`
                  : "File absent"}
              </pre>
            </div>
          ) : null}
          <div className="min-w-0">
            <h5 className="text-sm font-medium">Candidate · {path}</h5>
            <pre
              tabIndex={0}
              aria-label="Candidate file contents"
              className="max-h-96 overflow-auto rounded border p-3 text-xs"
            >
              {after
                ? after.encoding === "base64"
                  ? `Binary file · SHA-256 ${after.sha256} · mode ${after.mode} · ${after.size} bytes`
                  : `${after.mode ? `Mode ${after.mode}\n` : ""}${after.content}`
                : "File absent"}
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}
