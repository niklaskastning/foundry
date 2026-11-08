import {
  FoundryInstanceId,
  FoundryWorkerExecution,
  type EvaluationEvidence,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import { evaluationDigest } from "./Scorers.ts";

const decodeExecution = Schema.decodeUnknownOption(
  Schema.Struct({ execution: FoundryWorkerExecution }),
);
export const collectEvaluationEvidence = Effect.fn("EvaluationEvidence.collect")(function* (
  identity: { readonly instanceId: string; readonly operatorId: string },
  attempts: readonly { readonly id: string; readonly result: unknown; readonly kind: string }[],
) {
  const archive = yield* ThreadArchive.ThreadArchive;
  const evidence: EvaluationEvidence[] = [];
  let bytes = 0;
  const append = (id: string, source: string, content: string) => {
    bytes += new TextEncoder().encode(content).length;
    if (bytes > 100_000 || evidence.length >= 100) return false;
    evidence.push({ id, source, content, sha256: evaluationDigest(content) });
    return true;
  };
  if (attempts.length === 0 || attempts.length > 100) return [];
  for (const attempt of attempts) {
    if (
      !attempt.result ||
      !append(attempt.id, `attempt:${attempt.id}`, JSON.stringify(attempt.result))
    )
      return [];
    const decoded = decodeExecution(attempt.result);
    if (Option.isNone(decoded)) {
      if (attempt.kind === "publish" || attempt.kind === "approval") continue;
      return [];
    }
    const lifecycle = decoded.value.execution.lifecycle;
    const manifest = lifecycle?.manifest;
    if (!lifecycle?.writerEnded || !manifest?.archive) return [];
    const reference = manifest.archive;
    let after = 0;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = yield* archive
        .read(
          {
            instanceId: FoundryInstanceId.make(identity.instanceId),
            operatorId: identity.operatorId,
          },
          { owner: reference.owner, after, limit: 50 },
        )
        .pipe(Effect.orElseSucceed(() => null));
      if (!page?.complete || page.confirmedSourceSequence < reference.sourceSequence) return [];
      const events = page.events.filter(
        (event) =>
          event.sequence <= reference.cursor && event.sourceSequence <= reference.sourceSequence,
      );
      if (
        events.length &&
        !append(
          `${attempt.id}:page-${pageNumber}`,
          JSON.stringify({ owner: reference.owner, after, through: reference.cursor }),
          JSON.stringify(events),
        )
      )
        return [];
      const last = events.at(-1)?.sequence ?? after;
      if (last >= reference.cursor) {
        complete = true;
        break;
      }
      if (!page.nextCursor || page.nextCursor <= after) return [];
      after = page.nextCursor;
    }
    if (!complete) return [];
  }
  return evidence;
});
