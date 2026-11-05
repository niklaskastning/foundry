import { machineBearerToken } from "./MachineCredentials.ts";
import { FoundryAuthError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as DeviceConfig from "./DeviceConfig.ts";
import * as FoundrySessions from "./FoundrySessions.ts";

export const authenticate = Effect.fn("ClientIdentity.authenticate")(
  function* (request: HttpServerRequest.HttpServerRequest) {
    if (machineBearerToken(request.headers.authorization) !== undefined)
      return yield* new FoundryAuthError({ code: "invalid_session" });
    const sessions = yield* FoundrySessions.FoundrySessions;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const { origin } = yield* DeviceConfig.DeviceOrigin;
    const url = HttpServerRequest.toURL(request);
    if (request.headers.origin !== origin || Option.isNone(url) || url.value.origin !== origin)
      return yield* new FoundryAuthError({ code: "origin_forbidden" });
    yield* sessions.checkOrigin(request.headers.origin, request.headers["content-type"]);
    const foundry = yield* sessions.inspect(
      request.cookies[FoundrySessions.FOUNDRY_SESSION_COOKIE],
    );
    const csrf = request.headers["x-foundry-csrf"];
    if (!csrf || !timingSafeEqualBase64Url(csrf, foundry.csrfToken))
      return yield* new FoundryAuthError({ code: "csrf_invalid" });
    const client = yield* auth.authenticateHttpRequest(request);
    return { foundry, client };
  },
  Effect.mapError(
    (error) =>
      new FoundryAuthError({
        code:
          EnvironmentAuth.isServerAuthInternalError(error) ||
          (error._tag === "FoundryAuthError" && error.code === "unavailable")
            ? "unavailable"
            : "invalid_session",
      }),
  ),
);
