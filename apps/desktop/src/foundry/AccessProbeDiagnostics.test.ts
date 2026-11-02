import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { accessProbeFailure } from "./AccessProbeDiagnostics.ts";

const decodeSecretFixture = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.Number }));

it("identifies the failed probe stage without exposing transport or schema payloads", () => {
  const secret = "private-token-and-callback-code";
  for (const error of [new Error(`fetch failed ${secret}`), { message: secret }, secret]) {
    expect(accessProbeFailure("Read instance descriptor", error)).toBe(
      "Read instance descriptor: unexpected failure. No credentials are included in this report.",
    );
  }
  expect(
    accessProbeFailure(
      "Read Foundry session",
      new Error(`net::ERR_ABORTED at https://test/?token=${secret}`),
    ),
  ).toBe(
    "Read Foundry session: network request aborted. No credentials are included in this report.",
  );
  let invalid: unknown;
  try {
    decodeSecretFixture({ token: secret });
  } catch (error) {
    invalid = error;
  }
  expect(accessProbeFailure("Decode Foundry session", invalid)).toBe(
    "Decode Foundry session: response has an incompatible format. No credentials are included in this report.",
  );
});
