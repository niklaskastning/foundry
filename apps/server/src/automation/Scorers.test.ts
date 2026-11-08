import { expect, it } from "@effect/vitest";
import { EvaluationInput, FactoryV4Scorer } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { classifyJudgment, evaluationDigest, evaluationPreflight, sampleEvaluation } from "./Scorers.ts";

const fixture = (): EvaluationInput => ({
  id:"eval-1",factoryId:"factory-a",runId:"run-1",definitionRevision:"definition-1",runRevision:"a".repeat(40),definitionSource:{commitSha:"b".repeat(40)},modelConfiguration:{model:"original-model"},
  scorerRevision:"a".repeat(64),scorerSource:"git:scorers/quality.yaml@abc",mode:"automatic",
  scorer:{id:"quality",name:"Quality",criteria:[{id:"correctness",instructions:"Check acceptance evidence",threshold:0.8}],judge:{provider:"codex",model:"gpt-6.1-sol",reasoningEffort:"medium"},sampling:{rate:1,automatic:true}},
  evidence:[{id:"attempt-1",source:"attempt:1",content:"test passed",sha256:evaluationDigest("test passed")}],
});
it("samples deterministically per run and scorer revision, with explicit manual override",()=>{
  const input=fixture();
  expect(sampleEvaluation(input)).toBe(true);
  expect(sampleEvaluation({...input,scorer:{...input.scorer,sampling:{rate:0,automatic:true}}})).toBe(false);
  expect(sampleEvaluation({...input,scorer:{...input.scorer,sampling:{rate:1,automatic:false}}})).toBe(false);
  const half={...input,scorer:{...input.scorer,sampling:{rate:0.5,automatic:true}}};
  expect(sampleEvaluation({...half,id:"retry"})).toBe(sampleEvaluation(half));
  expect(sampleEvaluation({...half,mode:"manual",scorer:{...half.scorer,sampling:{rate:0,automatic:false}}})).toBe(true);
});
it("requires intact evidence and complete criterion coverage before classifying thresholds",()=>{
  const input=fixture();
  expect(evaluationPreflight(input)).toBeNull();
  expect(evaluationPreflight({...input,evidence:[]})).toEqual({status:"incomplete",reason:"missing_evidence"});
  expect(evaluationPreflight({...input,evidence:[{...input.evidence[0]!,content:"tampered"}]})).toEqual({status:"incomplete",reason:"missing_evidence"});
  const criterion={id:"correctness",score:0.8,rationale:"Tests pass",evidenceIds:["attempt-1"]};
  expect(classifyJudgment(input,{modelRevision:"gpt-6.1-sol",criteria:[criterion]})).toBe(true);
  expect(classifyJudgment(input,{modelRevision:"gpt-6.1-sol",criteria:[{...criterion,score:0.79}]})).toBe(false);
  for (const criteria of [[],[criterion,criterion],[{...criterion,id:"invented"}],[{...criterion,evidenceIds:["unknown"]}]]) {
    expect(classifyJudgment(input,{modelRevision:"gpt-6.1-sol",criteria})).toBeNull();
  }
});
it("rejects alternate judges, invalid thresholds and duplicate criteria",()=>{
  const scorer=fixture().scorer;
  expect(Schema.is(FactoryV4Scorer)(scorer)).toBe(true);
  for (const value of [{...scorer,judge:{...scorer.judge,model:"other"}},{...scorer,judge:{...scorer.judge,reasoningEffort:"high"}},{...scorer,criteria:[scorer.criteria[0],scorer.criteria[0]]},{...scorer,sampling:{rate:2,automatic:true}}]) expect(Schema.is(FactoryV4Scorer)(value)).toBe(false);
});
