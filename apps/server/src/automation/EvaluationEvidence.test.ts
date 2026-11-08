import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadArchive from "../foundry/ThreadArchive.ts";
import { collectEvaluationEvidence } from "./EvaluationEvidence.ts";
import { evaluationDigest } from "./Scorers.ts";

it.effect("keeps real nonagent evidence but rejects malformed agent results and partial snapshots",()=>Effect.gen(function*(){
  const principal={instanceId:"11111111-1111-4111-8111-111111111111",operatorId:"test"};
  const publish={id:"publish",kind:"publish",result:{publish:{commitSha:"a".repeat(40),url:"https://example.test/pr/1"}}};
  const evidence=yield* collectEvaluationEvidence(principal,[publish]);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.sha256).toBe(evaluationDigest(JSON.stringify(publish.result)));
  expect(yield* collectEvaluationEvidence(principal,[publish,{id:"agent",kind:"agent",result:{metadata:"not an execution"}}])).toEqual([]);
  expect(yield* collectEvaluationEvidence(principal,[{...publish,kind:"test"}])).toEqual([]);
  expect(yield* collectEvaluationEvidence(principal,[{...publish,result:null}])).toEqual([]);
  expect(yield* collectEvaluationEvidence(principal,[{...publish,result:{content:"x".repeat(100_001)}}])).toEqual([]);
}).pipe(Effect.provide(Layer.mock(ThreadArchive.ThreadArchive)({}))));
