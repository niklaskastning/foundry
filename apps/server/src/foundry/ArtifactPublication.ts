// @effect-diagnostics nodeBuiltinImport:off -- Bounded no-follow reads pin the claimed attachment while the existing device key signs transfers.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  CommandId,
  ThreadId,
  FoundryDevice,
  FoundryArtifactManifest,
  FoundryArtifactError,
  FoundryArchiveError,
  FoundryArchiveMachineRequest,
  type FoundryArchiveRequest,
  FOUNDRY_ARTIFACT_MAX_BYTES,
  FOUNDRY_ARTIFACT_CHUNK_BYTES,
  type ChatAttachment,
  type FoundryArtifactReference,
  type FoundryArtifactRequest,
} from "@t3tools/contracts";
import {
  artifactSha256,
  publishArtifact,
  downloadArtifact,
} from "@t3tools/shared/foundryArtifacts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest, FetchHttpClient, Headers } from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import {
  resolveAttachmentPath,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import { isDevelopmentLoopbackOrigin } from "./AccessConfig.ts";
import * as ArchiveTransport from "./ArchiveTransport.ts";
import { signArchiveRequest } from "./ThreadArchiveProof.ts";
import { signArtifactRequest } from "./ArtifactProof.ts";

export class ArtifactPublication extends Context.Reference<
  | {
      readonly publishAttachment: <Attachment extends ChatAttachment>(
        threadId: string,
        attachment: Attachment,
        retryId?: string,
      ) => Effect.Effect<Attachment, FoundryArtifactError>;
      readonly download: (reference: FoundryArtifactReference) => Effect.Effect<
        {
          readonly manifest: FoundryArtifactManifest;
          readonly bytes: Uint8Array;
        },
        FoundryArtifactError
      >;
    }
  | undefined
>("t3/foundry/ArtifactPublication", { defaultValue: () => undefined }) {}

const encodeArchiveMachineRequest = Schema.encodeEffect(FoundryArchiveMachineRequest);
const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeBinding = Schema.decodeUnknownEffect(
  Schema.Struct({
    origin: Schema.String,
    registrationFile: Schema.String,
    keyFile: Schema.String,
    accessFile: Schema.optional(Schema.String),
  }),
);
const decodeDevice = Schema.decodeUnknownEffect(FoundryDevice);
const decodeKey = Schema.decodeUnknownEffect(Schema.Struct({ privateKey: Schema.String }));
const decodeAccess = Schema.decodeUnknownEffect(
  Schema.Struct({
    origin: Schema.String,
    clientId: Schema.NonEmptyString,
    clientSecret: Schema.NonEmptyString,
  }),
);
const decodeManifest = Schema.decodeUnknownEffect(FoundryArtifactManifest);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.Struct({ code: FoundryArtifactError.fields.code }),
);
const isArtifactError = Schema.is(FoundryArtifactError);
const unavailable = () => new FoundryArtifactError({ code: "unavailable" });
const changed = () => new FoundryArtifactError({ code: "changed" });
const readBytes = Effect.fn("ArtifactPublication.readBytes")((path: string) =>
  Effect.tryPromise({
    try: async () => {
      const file = await NodeFSP.open(
        path,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(FOUNDRY_ARTIFACT_MAX_BYTES)) throw changed();
        const bytes = new Uint8Array(Number(before.size));
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
          if (bytesRead === 0) throw changed();
          offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw changed();
        return bytes;
      } finally {
        await file.close();
      }
    },
    catch: (error) => (isArtifactError(error) ? error : unavailable()),
  }),
);
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const bindingFile = yield* Config.String("FOUNDRY_WORKER_ARTIFACT_BINDING_FILE").pipe(
      Config.withDefault(""),
    );
    if (!bindingFile) return Layer.empty;
    const fs = yield* FileSystem.FileSystem;
    const http = yield* HttpClient.HttpClient;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const config = yield* ServerConfig.ServerConfig;
    const readJson = Effect.fn("ArtifactPublication.readConfiguration")(function* (path: string) {
      if (!NodePath.isAbsolute(path) || (yield* fs.stat(path)).size > 8192n)
        return yield* unavailable();
      return yield* parseJson(yield* fs.readFileString(path));
    }, Effect.mapError(unavailable));
    const binding = yield* readJson(bindingFile).pipe(
      Effect.flatMap(decodeBinding),
      Effect.mapError(unavailable),
    );
    const device = yield* readJson(binding.registrationFile).pipe(
      Effect.flatMap(decodeDevice),
      Effect.mapError(unavailable),
    );
    const key = yield* readJson(binding.keyFile).pipe(
      Effect.flatMap(decodeKey),
      Effect.mapError(unavailable),
    );
    const privateKey = Redacted.make(key.privateKey);
    const access = binding.accessFile
      ? yield* readJson(binding.accessFile).pipe(
          Effect.flatMap(decodeAccess),
          Effect.mapError(unavailable),
        )
      : undefined;
    const developmentLoopback = yield* Config.Boolean("FOUNDRY_WORKER_DEVELOPMENT_LOOPBACK").pipe(
      Config.withDefault(false),
    );
    const loopback = developmentLoopback && isDevelopmentLoopbackOrigin(binding.origin);
    if (
      !URL.canParse(binding.origin) ||
      (!loopback && new URL(binding.origin).protocol !== "https:") ||
      (loopback && access !== undefined) ||
      new URL(binding.origin).origin !== binding.origin ||
      device.environmentId !== (yield* environment.getEnvironmentId) ||
      device.revoked ||
      (access && access.origin !== binding.origin)
    )
      return yield* unavailable();
    const accessHeaders = access
      ? {
          "CF-Access-Client-Id": Redacted.make(access.clientId),
          "CF-Access-Client-Secret": Redacted.make(access.clientSecret),
        }
      : undefined;
    const root = yield* fs.realPath(config.attachmentsDir).pipe(Effect.mapError(unavailable));
    const redact = yield* Headers.CurrentRedactedNames;
    const send = Effect.fn("ArtifactPublication.request")(
      function* (input: FoundryArtifactRequest) {
        const issuedAt = yield* Clock.currentTimeMillis;
        const signed = yield* Effect.try({
          try: () =>
            signArtifactRequest(
              binding.origin,
              device,
              issuedAt,
              input,
              Redacted.value(privateKey),
            ),
          catch: unavailable,
        });
        const req = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${binding.origin}/api/foundry/devices/channel`, {
            headers: {
              "content-type": "application/json",
              ...(accessHeaders
                ? Object.fromEntries(
                    Object.entries(accessHeaders).map(([name, value]) => [
                      name,
                      Redacted.value(value),
                    ]),
                  )
                : {}),
            },
          }),
          signed,
        ).pipe(Effect.mapError(unavailable));
        const response = yield* http.execute(req).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
          }),
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...redact,
            "cf-access-client-id",
            "cf-access-client-secret",
          ]),
          Effect.mapError(unavailable),
        );
        if (response.status === 403) return yield* new FoundryArtifactError({ code: "forbidden" });
        if (response.status === 507) return yield* new FoundryArtifactError({ code: "capacity" });
        if (
          ![200, 400, 409].includes(response.status) ||
          !response.headers["content-type"]?.includes("application/json")
        )
          return yield* unavailable();
        const chunks = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ parts: [] as Uint8Array[], size: 0 }),
            (state, bytes) => {
              if (state.size + bytes.byteLength > FOUNDRY_ARTIFACT_CHUNK_BYTES * 2)
                return Effect.fail(changed());
              state.parts.push(bytes);
              state.size += bytes.byteLength;
              return Effect.succeed(state);
            },
          ),
          Effect.mapError((error) => (isArtifactError(error) ? error : unavailable())),
        );
        const bytes = new Uint8Array(chunks.size);
        let offset = 0;
        for (const chunk of chunks.parts) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const value = yield* parseJson(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(changed),
        );
        if (response.status !== 200) {
          const failure = yield* decodeFailure(value).pipe(Effect.mapError(unavailable));
          return yield* new FoundryArtifactError({ code: failure.code });
        }
        return value;
      },
      Effect.timeout("15 seconds"),
      Effect.catchTags({ TimeoutError: unavailable }),
    );
    const sendArchive = Effect.fn("ArtifactPublication.archiveRequest")(
      function* (input: FoundryArchiveRequest) {
        const issuedAt = yield* Clock.currentTimeMillis;
        const request = yield* Effect.try({
          try: () =>
            signArchiveRequest(binding.origin, device, issuedAt, input, Redacted.value(privateKey)),
          catch: () => new FoundryArchiveError({ code: "unavailable" }),
        });
        const encoded = yield* encodeArchiveMachineRequest(request).pipe(
          Effect.mapError(() => new FoundryArchiveError({ code: "invalid_request" })),
        );
        const req = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${binding.origin}/api/foundry/devices/channel`, {
            headers: {
              "content-type": "application/json",
              ...(accessHeaders
                ? Object.fromEntries(
                    Object.entries(accessHeaders).map(([name, value]) => [
                      name,
                      Redacted.value(value),
                    ]),
                  )
                : {}),
            },
          }),
          encoded,
        ).pipe(Effect.mapError(() => new FoundryArchiveError({ code: "unavailable" })));
        const response = yield* http.execute(req).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
            credentials: "omit",
          }),
          Effect.provideService(Headers.CurrentRedactedNames, [
            ...redact,
            "cf-access-client-id",
            "cf-access-client-secret",
          ]),
          Effect.mapError(() => new FoundryArchiveError({ code: "unavailable" })),
        );
        if (response.status === 403) return yield* new FoundryArchiveError({ code: "forbidden" });
        if (
          response.status !== 200 ||
          !response.headers["content-type"]?.includes("application/json")
        )
          return yield* new FoundryArchiveError({ code: "unavailable" });
        const bytes = yield* response.stream.pipe(
          Stream.runFoldEffect(
            () => ({ parts: [] as Uint8Array[], size: 0 }),
            (state, chunk) => {
              if (state.size + chunk.byteLength > 256 * 1024)
                return Effect.fail(new FoundryArchiveError({ code: "invalid_request" }));
              state.parts.push(chunk);
              state.size += chunk.byteLength;
              return Effect.succeed(state);
            },
          ),
          Effect.mapError(() => new FoundryArchiveError({ code: "unavailable" })),
        );
        const result = new Uint8Array(bytes.size);
        let offset = 0;
        for (const chunk of bytes.parts) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return yield* parseJson(new TextDecoder().decode(result)).pipe(
          Effect.mapError(() => new FoundryArchiveError({ code: "invalid_request" })),
        );
      },
      Effect.timeout("15 seconds"),
      Effect.catchTags({ TimeoutError: () => new FoundryArchiveError({ code: "unavailable" }) }),
    );
    return Layer.merge(
      Layer.succeed(ArchiveTransport.ArchiveTransport, { device, send: sendArchive }),
      Layer.succeed(ArtifactPublication, {
        publishAttachment: Effect.fn("ArtifactPublication.publishAttachment")(function* <
          Attachment extends ChatAttachment,
        >(threadId: string, attachment: Attachment, retryId?: string) {
          if (
            parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT
          )
            return yield* new FoundryArtifactError({ code: "invalid_request" });
          const path = resolveAttachmentPath({ attachmentsDir: root, attachment });
          if (
            !path ||
            (yield* fs.realPath(NodePath.dirname(path)).pipe(Effect.mapError(unavailable))) !== root
          )
            return yield* new FoundryArtifactError({ code: "forbidden" });
          const bytes = yield* readBytes(path);
          if (bytes.byteLength !== attachment.sizeBytes) return yield* changed();
          const sha = artifactSha256(bytes);
          const owner = { environmentId: device.environmentId, threadId: ThreadId.make(threadId) };
          let manifest: FoundryArtifactManifest;
          if (attachment.foundryArtifact) {
            const reference = attachment.foundryArtifact.reference;
            if (
              reference.instanceId !== device.instanceId ||
              reference.owner.environmentId !== owner.environmentId ||
              reference.owner.threadId !== owner.threadId
            )
              return yield* new FoundryArtifactError({ code: "forbidden" });
            manifest = yield* send({ op: "metadata", input: reference }).pipe(
              Effect.flatMap(decodeManifest),
              Effect.mapError((error) => (Schema.isSchemaError(error) ? changed() : error)),
            );
          } else {
            const commandId = CommandId.make(
              `artifact:${artifactSha256(new TextEncoder().encode(stableStringify([device.instanceId, owner, retryId ?? attachment.id, sha])))}`,
            );
            manifest = yield* publishArtifact(
              send,
              {
                instanceId: device.instanceId,
                commandId,
                owner,
                name: attachment.name,
                mimeType: attachment.mimeType.toLowerCase(),
                sizeBytes: bytes.byteLength,
                sha256: sha,
              },
              bytes,
            );
          }
          if (
            manifest.reference.instanceId !== device.instanceId ||
            manifest.reference.owner.environmentId !== owner.environmentId ||
            manifest.reference.owner.threadId !== owner.threadId ||
            (attachment.foundryArtifact !== undefined &&
              manifest.reference.artifactId !== attachment.foundryArtifact.reference.artifactId) ||
            manifest.sha256 !== sha ||
            manifest.name !== attachment.name ||
            manifest.mimeType !== attachment.mimeType.toLowerCase() ||
            manifest.sizeBytes !== bytes.byteLength
          )
            return yield* changed();
          return { ...attachment, foundryArtifact: manifest };
        }),
        download: Effect.fn("ArtifactPublication.download")((reference) =>
          downloadArtifact(send, reference),
        ),
      }),
    );
  }),
);
