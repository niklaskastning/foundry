import {
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type AssetImageDimensions,
  AssetResource,
  EnvironmentId,
  type ProjectCloneSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import type { ProjectFaviconCache, ProjectFaviconTarget } from "../projectFaviconCache.ts";
import { materializeAsset, readAssetChunks } from "./assetTransfer.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedError<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    const base = new URL(httpBaseUrl);
    if (
      base.pathname.startsWith("/api/foundry/gateway/devices/") &&
      !relativeUrl.startsWith("blob:") &&
      !relativeUrl.startsWith("data:")
    )
      return null;
    return new URL(relativeUrl, base).toString();
  } catch {
    return null;
  }
}

export const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("asset-url:empty"),
);

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | {
      readonly _tag: "Failure";
      readonly reason?: "missing-file-access";
    }
  | {
      readonly _tag: "Success";
      readonly url: string;
      readonly expiresAt: number;
      readonly sourcePath?: string;
      readonly imageDimensions?: AssetImageDimensions;
      readonly fileRevision?: string;
    };

export const MISSING_FILE_ACCESS_MESSAGE =
  "This connection cannot read host files. Pair again with a new link to view it.";

export function blockedAssetUrlState(
  resource: AssetResource | null,
  fileAccess: {
    readonly canReadFiles: boolean;
    readonly isPending: boolean;
    readonly error: string | null;
  },
): AssetUrlState | null {
  if (
    resource === null ||
    fileAccess.canReadFiles ||
    (resource._tag !== "workspace-file" &&
      resource._tag !== "media-file" &&
      resource._tag !== "draft-workspace-file")
  ) {
    return null;
  }
  if (fileAccess.isPending) return { _tag: "Loading" };
  return fileAccess.error === null
    ? { _tag: "Failure", reason: "missing-file-access" }
    : { _tag: "Failure" };
}

export function assetUrlStateFromResult(
  result: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
  httpBaseUrl: string | null,
): AssetUrlState {
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (httpBaseUrl === null || result._tag !== "Success") return { _tag: "Loading" };
  const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    expiresAt: result.value.expiresAt,
    ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
    ...(result.value.imageDimensions !== undefined
      ? { imageDimensions: result.value.imageDimensions }
      : {}),
    ...(result.value.fileRevision !== undefined ? { fileRevision: result.value.fileRevision } : {}),
  };
}

export function materializeAssetQuery<E, DE>(
  source: Atom.Atom<
    AsyncResult.AsyncResult<AssetCreateUrlResult & { readonly foundry: boolean }, E>
  >,
  download: (
    asset: AssetCreateUrlResult,
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.Effect<Uint8Array<ArrayBuffer>, DE>,
) {
  return Atom.make((get): Effect.Effect<AssetCreateUrlResult, E | DE> => {
    const result = get(source);
    if (result._tag === "Initial") return Effect.never;
    if (result._tag === "Failure") return Effect.failCause(result.cause);
    const asset = result.value;
    if (!asset.foundry) return Effect.succeed<AssetCreateUrlResult>(asset);
    return download(asset, get.registry).pipe(
      Effect.map((bytes): AssetCreateUrlResult => {
        const local = materializeAsset(bytes, asset.relativeUrl);
        get.addFinalizer(local.dispose);
        return { ...asset, relativeUrl: local.url };
      }),
    );
  }).pipe(Atom.setIdleTTL(0));
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  localMediaEnvironment?: Atom.Atom<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
  } | null>,
) {
  const readChunk = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:assets:read-chunk",
    tag: WS_METHODS.assetsReadChunk,
  });
  const execute = Effect.fn("assets.createUrl")(function* (input: AssetCreateUrlInput) {
    const result = yield* request(WS_METHODS.assetsCreateUrl, input).pipe(Effect.result);
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    if (Result.isSuccess(result)) {
      return { ...result.success, foundry: supervisor.target._tag === "FoundryConnectionTarget" };
    }
    const error = result.failure;
    const resource = input.resource;
    const local = localMediaEnvironment
      ? (yield* AtomRegistry.AtomRegistry).get(localMediaEnvironment)
      : null;
    if (
      supervisor.target._tag === "FoundryConnectionTarget" ||
      !local ||
      local.environmentId === supervisor.target.environmentId ||
      !(
        error._tag === "AssetWorkspaceAssetNotFoundError" ||
        error._tag === "AssetWorkspaceAssetInspectionError" ||
        error._tag === "AssetWorkspaceContextNotFoundError"
      ) ||
      resource._tag !== "media-file" ||
      !(resource.path.startsWith("/") || isWindowsAbsolutePath(resource.path)) ||
      mediaMimeTypeFromExtension(resource.path.slice(resource.path.lastIndexOf("."))) === null
    )
      return yield* error;
    const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
    // Map the full cause so retry defects and interruption survive.
    const asset = yield* environments
      .run(local.environmentId, request(WS_METHODS.assetsCreateUrl, input))
      .pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, () => error))));
    return {
      ...asset,
      relativeUrl: new URL(asset.relativeUrl, local.httpBaseUrl).href,
      foundry: false,
    };
  });
  const query = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    execute,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
    refreshTrigger: ({ input }) =>
      input.resource._tag === "media-file" ? localMediaEnvironment : undefined,
  });
  const materialized = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((source: ReturnType<typeof query>) =>
      materializeAssetQuery(source, (asset, registry) =>
        readAssetChunks(asset.relativeUrl, (chunk) =>
          Effect.promise(() =>
            readChunk.run(registry, {
              environmentId,
              input: chunk,
            }),
          ).pipe(
            Effect.flatMap((result) =>
              result._tag === "Success"
                ? Effect.succeed(result.value)
                : Effect.failCause(result.cause),
            ),
          ),
        ),
      ),
    ),
  );
  const createUrl = (target: Parameters<typeof query>[0]) =>
    materialized(target.environmentId)(query(target));
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:assets:create-urls:${key}`));
  });

  return {
    createSignedUrl: query,
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}

export function createProjectFaviconUrlAtomFamily(input: {
  readonly imageCache?: ProjectFaviconCache;
  readonly createUrl: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>;
  readonly preparedConnection: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<{ readonly httpBaseUrl: string }>>;
  readonly projectClones?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<ProjectCloneSnapshot>>;
}) {
  const decodeKey = Schema.decodeUnknownSync(
    Schema.Tuple([EnvironmentId, Schema.String, Schema.NullOr(Schema.String)]),
  );
  const projectClones = input.projectClones;
  const family = Atom.family((key: string) => {
    const [environmentId, cwd, path] = decodeKey(JSON.parse(key));
    const resource = { _tag: "project-favicon" as const, cwd, ...(path ? { path } : {}) };
    const query = input.createUrl({ environmentId, input: { resource } });
    // A cloned project exists before its files do, and the server reports its
    // icon missing until the clone lands. Ask again whenever the clone's phase
    // changes: the first list a client sees may already say done.
    const request = projectClones
      ? query.pipe(
          Atom.makeRefreshOnSignal(
            Atom.make(
              (get) =>
                get(projectClones(environmentId)).find((clone) => clone.destinationPath === cwd)
                  ?.phase ?? null,
            ),
          ),
        )
      : query;
    const resolvedUrl = Atom.make((get): string | null => {
      const result = get(request);
      const connection = get(input.preparedConnection(environmentId));
      const state = assetUrlStateFromResult(
        result,
        Option.isSome(connection) ? connection.value.httpBaseUrl : null,
      );
      return state._tag === "Success" ? state.url : Option.getOrNull(get.self<string | null>());
    }).pipe(Atom.setIdleTTL(0));
    const cache = input.imageCache;
    if (!cache) return resolvedUrl;

    const target = { environmentId, cwd, faviconPath: path };
    const image = Atom.make((get) => {
      get(request);
      const url = get(resolvedUrl);
      return Effect.promise((signal) => cache.resolve(target, url, signal));
    }).pipe(Atom.setIdleTTL(0));

    return Atom.make((get): string | null => {
      const result = get(image);
      if (isProjectFaviconFallbackUrl(get(resolvedUrl))) return null;
      return AsyncResult.getOrElse(result, () => cache.peek(target));
    }).pipe(Atom.setIdleTTL(0));
  });
  return (target: ProjectFaviconTarget) =>
    family(getProjectFaviconResourceKey(target.environmentId, target.cwd, target.faviconPath));
}
