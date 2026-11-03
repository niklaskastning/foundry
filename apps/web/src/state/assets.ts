import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@t3tools/client-runtime/state/assets";
import { Atom } from "effect/reactivity";
import { AssetResource, EnvironmentId, type AssetCreateUrlResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";
import { artifactUrl } from "../foundry/artifacts";

import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentProjectClonesAtom } from "./projectClones";
import { environmentSession } from "./session";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

const workerAssets = createAssetEnvironmentAtoms(connectionAtomRuntime, localMediaEnvironment);
const createUrl = (
  target: Parameters<typeof workerAssets.createUrl>[0],
): Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>> =>
  target.input.resource._tag === "attachment" && target.input.resource.foundryArtifact
    ? artifactUrl(target.input.resource.foundryArtifact)
    : workerAssets.createUrl(target);
const decodeCollection = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);
const collections = Atom.family((key: string) => {
  const [environmentId, resources] = decodeCollection(JSON.parse(key));
  return Atom.make((get) =>
    resources.map((resource) => get(createUrl({ environmentId, input: { resource } }))),
  ).pipe(Atom.setIdleTTL(0));
});
export const assetEnvironment = {
  ...workerAssets,
  createUrl,
  createUrls: (target: {
    readonly environmentId: EnvironmentId;
    readonly resources: ReadonlyArray<AssetResource>;
  }) => collections(JSON.stringify([target.environmentId, target.resources])),
};

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectClonesAtom,
});
