import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FoundryDeviceId,
  FoundryInstanceId,
  FoundryArchiveEvent,
  FoundryArchiveMachineRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { generateDeviceKey } from "./DeviceProof.ts";
import { signArchiveRequest, verifyArchiveRequest } from "./ThreadArchiveProof.ts";

const decodeEvent = Schema.decodeSync(FoundryArchiveEvent);
const codec = Schema.fromJsonString(FoundryArchiveMachineRequest);
const decodeMachine = Schema.decodeSync(codec);
const encodeMachine = Schema.encodeSync(codec);

it("preserves signed event dates across JSON transport and binds operation, origin and generation", () => {
  const key = generateDeviceKey();
  const device = {
    deviceId: FoundryDeviceId.make("11111111-1111-4111-8111-111111111111"),
    instanceId: FoundryInstanceId.make("22222222-2222-4222-8222-222222222222"),
    environmentId: EnvironmentId.make("archive-worker"),
    publicKey: key.publicKey,
    generation: 1,
    revoked: false,
  };
  const owner = { environmentId: device.environmentId, threadId: ThreadId.make("archive-thread") };
  const now = "2026-11-03T12:00:00.000Z";
  const event = decodeEvent({
    sequence: 1,
    sourceSequence: 10,
    event: {
      id: "event:message",
      type: "message.updated",
      threadId: owner.threadId,
      occurredAt: now,
      payload: {
        id: "message:1",
        threadId: owner.threadId,
        runId: null,
        nodeId: null,
        createdBy: "user",
        creationSource: "web",
        role: "user",
        text: "persisted archive message",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const origin = "https://main.example.test";
  const proof = signArchiveRequest(
    origin,
    device,
    1000,
    {
      op: "ingest",
      input: {
        instanceId: device.instanceId,
        owner,
        sourceHead: 1,
        sourceComplete: false,
        events: [event],
      },
    },
    key.privateKey,
  );
  const received = decodeMachine(encodeMachine(proof));
  expect(verifyArchiveRequest(origin, received, key.publicKey)).toBe(true);
  expect(verifyArchiveRequest("https://foreign.example.test", received, key.publicKey)).toBe(false);
  for (const changed of [
    { ...received, generation: 2 },
    { ...received, issuedAt: 1001 },
    { ...received, request: { op: "cursor" as const, input: owner } },
    { ...received, environmentId: EnvironmentId.make("foreign-worker") },
    { ...received, signature: received.signature.slice(1) },
  ])
    expect(verifyArchiveRequest(origin, changed, key.publicKey)).toBe(false);
});
