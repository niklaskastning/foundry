import * as Schema from "effect/Schema";

export function accessProbeFailure(stage: string, error: unknown): string {
  const networkCode =
    error instanceof Error ? /\bnet::(ERR_[A-Z_]+)\b/.exec(error.message)?.[1] : undefined;
  const networkFailures: Record<string, string> = {
    ERR_ABORTED: "network request aborted",
    ERR_BLOCKED_BY_CLIENT: "network request blocked by the client",
    ERR_CONNECTION_RESET: "network connection reset",
    ERR_CONNECTION_REFUSED: "network connection refused",
    ERR_NAME_NOT_RESOLVED: "server name could not be resolved",
    ERR_CERT_DATE_INVALID: "server certificate date invalid",
    ERR_CERT_AUTHORITY_INVALID: "server certificate authority invalid",
    ERR_FAILED: "network request failed",
  };
  const reason =
    error instanceof Schema.SchemaError
      ? "response has an incompatible format"
      : error instanceof Error && error.name === "TimeoutError"
        ? "request timed out"
        : (networkCode && networkFailures[networkCode]) || "unexpected failure";
  return `${stage}: ${reason}. No credentials are included in this report.`;
}
