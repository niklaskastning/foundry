import {
  AutomationInboxEntry,
  AutomationInboxError,
  AutomationInboxMark,
  AutomationInboxPage,
  AutomationInboxQuery,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as AutomationDatabase from "./AutomationDatabase.ts";
import * as WorkerTransport from "./WorkerTransport.ts";

type Request = HttpServerRequest.HttpServerRequest;
type Identity = Pick<WorkerTransport.WorkerIdentity, "instanceId" | "operatorId">;
const decodeQuery = Schema.decodeUnknownEffect(AutomationInboxQuery, { onExcessProperty: "error" });
const decodeMark = Schema.decodeUnknownEffect(AutomationInboxMark, { onExcessProperty: "error" });
const decodeEntry = Schema.decodeUnknownEffect(AutomationInboxEntry);
const isInboxError = Schema.is(AutomationInboxError);
const failure = (cause: unknown) =>
  isInboxError(cause) ? cause : new AutomationInboxError({ reason: "unavailable" });

export class Inbox extends Context.Service<
  Inbox,
  {
    readonly query: (
      request: Request,
      input: AutomationInboxQuery,
    ) => Effect.Effect<AutomationInboxPage, AutomationInboxError>;
    readonly mark: (
      request: Request,
      input: AutomationInboxMark,
    ) => Effect.Effect<AutomationInboxEntry, AutomationInboxError>;
  }
>()("t3/automation/Inbox") {}

const make = Effect.gen(function* () {
  const sql = yield* AutomationDatabase.AutomationDatabase;
  const worker = yield* WorkerTransport.WorkerTransport;
  const identity = Effect.fn("Inbox.identity")((request: Request) =>
    worker
      .identityForRead(request)
      .pipe(Effect.mapError(() => new AutomationInboxError({ reason: "forbidden" }))),
  );
  const reconcile = Effect.fn("Inbox.reconcile")(function* (owner: Identity) {
    // Serialize source reconciliation and personal marks; no remote work occurs under this lock.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(${owner.instanceId}::text,${owner.operatorId}::text,'inbox')::text,0))`;
    yield* sql`
      WITH owned AS (
        SELECT r.id AS run_id,r.factory_id,r.work_item_id,w.title,f.name AS factory_name,d.state,d.reason,d.binding,
          c.revision,c.result_revision,c.mode,v.steps,d.v4_state,
          (SELECT a.receipt->'receipt'->>'threadId' FROM foundry_automation.step_attempts a
            WHERE a.run_id=r.id ORDER BY a.ordinal DESC,a.attempt_number DESC LIMIT 1) AS thread_id
        FROM foundry_automation.runs r
        JOIN foundry_automation.factories f ON f.id=r.factory_id
        JOIN foundry_automation.dispatch_runs d ON d.run_id=r.id
        JOIN foundry_automation.run_controls c ON c.run_id=r.id
        JOIN foundry_automation.work_items w ON w.id=r.work_item_id
        JOIN foundry_automation.workflow_versions v ON v.id=r.workflow_version_id
        WHERE d.binding->'identity'->>'instanceId'=${owner.instanceId}
          AND d.binding->'identity'->>'operatorId'=${owner.operatorId}
      ), facts AS (
        SELECT o.*, 'question'::text AS kind,q.request_id AS source_key,q.thread_id AS source_thread,
          q.request_id,NULL::text AS step_id,q.payload->'questions' AS questions,q.answer->'answers' AS answer,
          q.status='pending' AND COALESCE(q.payload->'request'->>'kind','')='user_input'
            AND COALESCE(q.payload->'request'->>'status','')='pending'
            AND COALESCE(q.payload->'request'->'responseCapability'->>'type','') IN ('live','message')
            AND o.state NOT IN ('failed','succeeded') AND o.mode NOT IN ('cancelled','cancel_requested')
            AND EXISTS (SELECT 1 FROM foundry_automation.step_attempts a
              WHERE a.run_id=o.run_id AND a.receipt->'receipt'->>'threadId'=q.thread_id AND a.command_id=COALESCE(q.payload->>'attemptCommandId',(SELECT original.command_id FROM foundry_automation.step_attempts original WHERE original.run_id=q.run_id AND original.receipt->'receipt'->>'threadId'=q.thread_id ORDER BY original.ordinal,original.attempt_number LIMIT 1))
                AND a.state IN ('pending','running','waiting','finalizing')
                AND NOT EXISTS (SELECT 1 FROM foundry_automation.step_attempts newer
                  WHERE newer.run_id=a.run_id AND newer.ordinal=a.ordinal AND newer.attempt_number>a.attempt_number)
                AND a.result#>'{execution,lifecycle,writerEnded}' IS DISTINCT FROM 'true'::jsonb) AS active,
          q.source_sequence::text || ':' || q.status AS fact_revision,
          'Question: ' || o.title AS fact_title,'A response is required in the linked agent thread.'::text AS detail
        FROM owned o JOIN foundry_automation.run_questions q ON q.run_id=o.run_id
        UNION ALL
        SELECT o.*,'answer',q.request_id,q.thread_id,q.request_id,NULL,q.payload->'questions',q.answer->'answers',true,
          q.source_sequence::text || ':' || q.status,'Answer: ' || o.title,'The response has been recorded.'
        FROM owned o JOIN foundry_automation.run_questions q ON q.run_id=o.run_id
        WHERE q.answer IS NOT NULL
        UNION ALL
        SELECT o.*,'approval',s.step->>'id',o.thread_id,NULL,s.step->>'id',NULL,NULL,
          o.mode NOT IN ('cancelled','cancel_requested') AND o.state='waiting'
            AND NOT EXISTS (SELECT 1 FROM foundry_automation.run_decisions decision
              WHERE decision.run_id=o.run_id AND decision.step_id=s.step->>'id' AND decision.approved
                AND decision.result_revision=o.result_revision AND decision.revision=(
                  SELECT max(latest.revision) FROM foundry_automation.run_decisions latest
                  WHERE latest.run_id=o.run_id AND latest.step_id=decision.step_id)),s.step::text,
          'Approval: ' || o.title,CASE WHEN s.step->>'kind'='publish' THEN
            COALESCE((SELECT 'Publish commit ' || (a.result->'execution'->'lifecycle'->'manifest'->'publishEvidence'->>'commitSha')
              || ' to ' || (a.result->'execution'->'lifecycle'->'manifest'->'publishEvidence'->>'repository')
              || '. Review the confirmed checks and bundle in the run result before approving.'
              FROM foundry_automation.step_attempts a WHERE a.run_id=o.run_id
                AND a.result->'execution'->'lifecycle'->'manifest'->'publishEvidence' IS NOT NULL
              ORDER BY a.ordinal DESC,a.attempt_number DESC LIMIT 1),
              'No confirmed publish commit. Publishing stays blocked until matching commit and test evidence exists.')
            ELSE COALESCE(s.step->>'prompt','Review the current result before publication.') END
        FROM owned o CROSS JOIN LATERAL (
          SELECT step,ordinality FROM (
            SELECT step,ordinality FROM jsonb_array_elements(o.steps) WITH ORDINALITY AS steps(step,ordinality)
            WHERE o.v4_state IS NULL AND (NOT EXISTS (SELECT 1 FROM foundry_automation.step_attempts a
            WHERE a.run_id=o.run_id AND a.ordinal=ordinality-1 AND a.state='succeeded')
          OR (o.reason='approval_revision_changed' AND step->>'kind'='approval'
            AND NOT EXISTS (SELECT 1 FROM foundry_automation.run_decisions decision
              WHERE decision.run_id=o.run_id AND decision.step_id=step->>'id' AND decision.approved
                AND decision.result_revision=o.result_revision AND decision.revision=(
                  SELECT max(latest.revision) FROM foundry_automation.run_decisions latest
                  WHERE latest.run_id=o.run_id AND latest.step_id=decision.step_id)))
            )

            UNION ALL
            SELECT (node->'definition') || jsonb_build_object('id',node->>'path','prompt',node->'definition'->>'instructions'),
              ((node->>'ordinal')::bigint + 1) AS ordinality
            FROM jsonb_array_elements(o.v4_state->'nodes') node
            WHERE node->>'status' IN ('ready','waiting')
              AND node->'definition'->>'kind' IN ('approval','publish')
          ) eligible ORDER BY ordinality LIMIT 1
        ) s
        WHERE s.step->>'kind' IN ('approval','publish')
        UNION ALL
        SELECT o.*,CASE WHEN o.state='failed' THEN 'error' ELSE 'blocker' END,'state',o.thread_id,
          NULL,NULL,NULL,NULL,true,COALESCE(o.reason,o.state),
          CASE WHEN o.state='failed' THEN 'Failed: ' ELSE 'Blocked: ' END || o.title,
          COALESCE(o.reason,o.state)
        FROM owned o WHERE o.state IN ('waiting','failed') AND o.reason IS NOT NULL
          AND o.reason NOT IN ('approval_required','publish_required','human_approval_required')
          AND o.mode NOT IN ('cancelled','cancel_requested')
      ), sources AS (
        SELECT md5(jsonb_build_array(${owner.instanceId}::text,${owner.operatorId}::text,run_id,kind,source_key)::text) AS id,
          factory_id,work_item_id,run_id,kind,active,
          md5(jsonb_build_array(revision,result_revision,fact_revision)::text) AS source_revision,
          jsonb_build_object('factoryName',factory_name,'workItemTitle',title,'factoryId',factory_id,'workItemId',work_item_id,'runId',run_id,
            'kind',kind,'title',fact_title,'detail',detail,'stepId',COALESCE(step_id,CASE WHEN v4_state IS NULL THEN steps->origin.ordinal->>'id' ELSE (SELECT node->>'path' FROM jsonb_array_elements(v4_state->'nodes') node WHERE (node->>'ordinal')::int=origin.ordinal LIMIT 1) END),'requestId',request_id,
            'threadId',source_thread,'environmentId',binding->'identity'->>'environmentId',
            'expectedRevision',revision,'resultRevision',result_revision,
            'questions',CASE WHEN jsonb_typeof(questions)='array' THEN questions ELSE '[]'::jsonb END,
            'answer',answer,
            'status',CASE WHEN kind='answer' OR (kind='question' AND answer IS NOT NULL) THEN 'answered'
              WHEN mode IN ('cancelled','cancel_requested') THEN 'cancelled'
              WHEN kind='question' AND EXISTS (SELECT 1 FROM foundry_automation.run_questions q
                WHERE q.run_id=facts.run_id AND q.request_id=facts.request_id
                  AND q.payload#>>'{request,status}'='cancelled') THEN 'cancelled'
              WHEN kind='question' AND EXISTS (SELECT 1 FROM foundry_automation.run_questions q
                WHERE q.run_id=facts.run_id AND q.request_id=facts.request_id
                  AND q.payload#>>'{request,status}'='resolved') THEN 'resolved'
              WHEN active THEN 'pending'
              WHEN kind='approval' AND EXISTS (SELECT 1 FROM foundry_automation.run_decisions decision
                WHERE decision.run_id=facts.run_id AND decision.step_id=facts.step_id
                  AND decision.result_revision=facts.result_revision AND decision.approved) THEN 'resolved'
              ELSE 'superseded' END,
            'attemptCommandId',origin.command_id,
            'questionRevision',CASE WHEN kind='question' THEN split_part(fact_revision,':',1) ELSE NULL END) AS source
        FROM facts LEFT JOIN LATERAL (
          SELECT a.command_id,a.ordinal FROM foundry_automation.step_attempts a
          WHERE a.run_id=facts.run_id AND a.receipt->'receipt'->>'threadId'=source_thread
            AND a.command_id=COALESCE((SELECT q.payload->>'attemptCommandId'
              FROM foundry_automation.run_questions q WHERE q.run_id=facts.run_id AND q.request_id=facts.request_id),
              (SELECT original.command_id FROM foundry_automation.step_attempts original
                WHERE original.run_id=facts.run_id AND original.receipt->'receipt'->>'threadId'=source_thread
                ORDER BY original.ordinal,original.attempt_number LIMIT 1))
          ORDER BY a.ordinal DESC,a.attempt_number DESC LIMIT 1
        ) origin ON true
      ), saved AS (
        INSERT INTO foundry_automation.inbox_entries(id,instance_id,operator_id,factory_id,work_item_id,run_id,kind,source_revision,source,active)
        SELECT id,${owner.instanceId},${owner.operatorId},factory_id,work_item_id,run_id,kind,source_revision,source,active FROM sources
        ON CONFLICT(id) DO UPDATE SET source_revision=EXCLUDED.source_revision,source=EXCLUDED.source,
          active=EXCLUDED.active,updated_at=clock_timestamp()
        WHERE inbox_entries.source_revision<>EXCLUDED.source_revision OR inbox_entries.active<>EXCLUDED.active OR inbox_entries.source IS DISTINCT FROM EXCLUDED.source
        RETURNING id
      )
      UPDATE foundry_automation.inbox_entries e SET active=false,updated_at=clock_timestamp()
      WHERE e.instance_id=${owner.instanceId} AND e.operator_id=${owner.operatorId} AND e.active
        AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=e.id)
    `;
  });
  const read = Effect.fn("Inbox.read")(function* (owner: Identity, id: string) {
    const rows = yield* sql<{ entry: unknown }>`
      SELECT e.source || jsonb_strip_nulls(jsonb_build_object('factoryName',f.name,'workItemTitle',w.title)) || jsonb_build_object('id',e.id,'sourceRevision',e.source_revision,'active',e.active,
        'isRead',COALESCE(m.is_read,false),'isDone',(COALESCE(m.is_done,false) OR (e.kind<>'answer' AND COALESCE(e.source->>'status' IN ('answered','resolved'),false)))) AS entry
      FROM foundry_automation.inbox_entries e
      LEFT JOIN foundry_automation.factories f ON f.id=e.factory_id
      LEFT JOIN foundry_automation.work_items w ON w.factory_id=e.factory_id AND w.id=e.work_item_id
      LEFT JOIN foundry_automation.inbox_marks m ON m.item_id=e.id AND m.operator_id=e.operator_id AND m.source_revision=e.source_revision
      WHERE e.id=${id} AND e.instance_id=${owner.instanceId} AND e.operator_id=${owner.operatorId}`;
    if (!rows[0]) return yield* new AutomationInboxError({ reason: "not_found" });
    return yield* decodeEntry(rows[0].entry);
  });
  const query = Effect.fn("Inbox.query")(function* (request: Request, raw: AutomationInboxQuery) {
    const input = yield* decodeQuery(raw);
    const owner = yield* identity(request);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* reconcile(owner);
        const limit = input.limit ?? 30;
        const rows = yield* sql<{ entry: unknown }>`
        SELECT e.source || jsonb_strip_nulls(jsonb_build_object('factoryName',f.name,'workItemTitle',w.title)) || jsonb_build_object('id',e.id,'sourceRevision',e.source_revision,'active',e.active,
          'isRead',COALESCE(m.is_read,false),'isDone',(COALESCE(m.is_done,false) OR (e.kind<>'answer' AND COALESCE(e.source->>'status' IN ('answered','resolved'),false)))) AS entry
        FROM foundry_automation.inbox_entries e
      LEFT JOIN foundry_automation.factories f ON f.id=e.factory_id
      LEFT JOIN foundry_automation.work_items w ON w.factory_id=e.factory_id AND w.id=e.work_item_id
        LEFT JOIN foundry_automation.inbox_marks m ON m.item_id=e.id AND m.operator_id=e.operator_id AND m.source_revision=e.source_revision
        WHERE e.instance_id=${owner.instanceId} AND e.operator_id=${owner.operatorId}
          AND (${input.factoryId ?? null}::text IS NULL OR e.factory_id=${input.factoryId ?? null})
          AND (${input.kind ?? null}::text IS NULL OR e.kind=${input.kind ?? null})
          AND (${input.cursor ?? null}::text IS NULL OR e.id>${input.cursor ?? null})
          AND (${input.status ?? "open"}='all' OR (${input.status ?? "open"}='done' AND (COALESCE(m.is_done,false) OR (e.kind<>'answer' AND COALESCE(e.source->>'status' IN ('answered','resolved'),false))))
            OR (${input.status ?? "open"}='open' AND e.active AND NOT COALESCE(m.is_done,false) AND (e.kind='answer' OR COALESCE(e.source->>'status' NOT IN ('answered','resolved'),true))))
          AND (NOT ${input.unreadOnly ?? false} OR NOT COALESCE(m.is_read,false))
        ORDER BY e.id LIMIT ${limit + 1}`;
        const entries = yield* Effect.forEach(rows.slice(0, limit), (row) =>
          decodeEntry(row.entry),
        );
        return { items: entries, nextCursor: rows.length > limit ? entries.at(-1)!.id : null };
      }),
    );
  }, Effect.mapError(failure));
  const mark = Effect.fn("Inbox.mark")(function* (request: Request, raw: AutomationInboxMark) {
    const input = yield* decodeMark(raw);
    const owner = yield* identity(request);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* reconcile(owner);
        const prior = yield* sql<{
          same: boolean;
          receipt: unknown;
        }>`SELECT c.kind='inbox.mark' AND r.operator_id=${owner.operatorId} AND c.payload=${sql.json({ ...input, instanceId: owner.instanceId })}::jsonb AS same,r.receipt FROM foundry_automation.commands c LEFT JOIN foundry_automation.inbox_commands r ON r.id=c.id WHERE c.id=${input.commandId}`;
        if (prior[0]) {
          if (!prior[0].same)
            return yield* new AutomationInboxError({ reason: "command_conflict" });
          return yield* decodeEntry(prior[0].receipt);
        }
        const entry = yield* read(owner, input.itemId);
        if (entry.sourceRevision !== input.sourceRevision)
          return yield* new AutomationInboxError({ reason: "stale_revision" });
        const reserved =
          yield* sql`INSERT INTO foundry_automation.commands(id,kind,payload) VALUES(${input.commandId},'inbox.mark',${sql.json({ ...input, instanceId: owner.instanceId })}) ON CONFLICT DO NOTHING RETURNING id`;
        if (reserved.length !== 1)
          return yield* new AutomationInboxError({ reason: "command_conflict" });
        const isRead =
          input.action === "read" ? true : input.action === "unread" ? false : entry.isRead;
        const isDone =
          (entry.kind !== "answer" &&
            (entry.status === "answered" || entry.status === "resolved")) ||
          (input.action === "done" ? true : input.action === "reopen" ? false : entry.isDone);
        yield* sql`INSERT INTO foundry_automation.inbox_marks(operator_id,item_id,source_revision,is_read,is_done) VALUES(${owner.operatorId},${entry.id},${entry.sourceRevision},${isRead},${isDone}) ON CONFLICT(operator_id,item_id,source_revision) DO UPDATE SET is_read=EXCLUDED.is_read,is_done=EXCLUDED.is_done`;
        const result = { ...entry, isRead, isDone };
        yield* sql`INSERT INTO foundry_automation.inbox_commands(id,operator_id,payload,receipt) VALUES(${input.commandId},${owner.operatorId},${sql.json({ ...input, instanceId: owner.instanceId })},${sql.json(result)})`;
        return result;
      }),
    );
  }, Effect.mapError(failure));
  return Inbox.of({ query, mark });
});
export const layer = Layer.effect(Inbox, make);
