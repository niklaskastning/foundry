export declare function versionMatches(output: string, version: string): boolean;
export declare function validateDeadline(expiresAt: number, maximum: number, now: number): number;
export declare function setup(
  input: {
    repositoryUrl: string;
    revision: string;
    setup: string[][];
    tools: { command: string; version: string }[];
    skills?: ReadonlyArray<import("@t3tools/contracts").FactoryV4Skill>;
  },
  paths?: { workspace: string; private: string },
  run?: (argv: string[], cwd: string, output: (text: string) => void) => Promise<string>,
): Promise<{
  state: "ready";
  fingerprint: string;
  revision: string;
  tools: { command: string; version: string }[];
}>;

export declare function prepareRuntime(
  input: {
    origin: string;
    registration: { environmentId: string; publicKey: string };
    environment?: Record<string, string>;
    providerBinding?: {
      connectionId: string;
      connectionGeneration: number;
      providerInstanceId: string;
      profileKey: string;
      allocationId: string;
      factoryId: string | null;
    };
  },
  identity: { environmentId: string; publicKey: string },
  privateDirectory?: string,
): Promise<Record<string, string>>;

export declare function restoreDeadline(
  initial: number,
  maximum: number,
  now: number,
  stored?: { expiresAt: number; maximum: number },
): number;

export declare function writeResumeChunk(
  input: { offset: number; base64: string; receipt?: unknown },
  directory?: string,
): Promise<{ offset: number }>;

export declare function resume(
  paths?: { workspace: string; private: string; runtime: string },
  run?: (argv: string[], cwd: string, output: (text: string) => void) => Promise<string>,
): Promise<{
  digest: string;
  source: unknown;
  headCommit: string;
  checkpointCommit: string;
  checkpointTree: string;
}>;
