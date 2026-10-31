import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as FoundrySessions from "./FoundrySessions.ts";

const headers = { "cache-control": "no-store", pragma: "no-cache" };
const cookieOptions = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = yield* FoundrySessions.FoundrySessions;
    const route = (operation: "login" | "session" | "refresh" | "logout") =>
      HttpRouter.add(
        "POST",
        `/api/foundry/auth/${operation}`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* sessions.checkOrigin(request.headers.origin, request.headers["content-type"]);
          const token = request.cookies[FoundrySessions.FOUNDRY_SESSION_COOKIE];
          const csrf = request.headers["x-foundry-csrf"];
          if (operation === "session")
            return HttpServerResponse.jsonUnsafe(yield* sessions.inspect(token), { headers });
          if (operation === "logout") {
            yield* sessions.logout(token, csrf);
            return HttpServerResponse.expireCookieUnsafe(
              HttpServerResponse.empty({ status: 204, headers }),
              FoundrySessions.FOUNDRY_SESSION_COOKIE,
              cookieOptions,
            );
          }
          const issued = yield* operation === "login"
            ? sessions.login(request.headers["cf-access-jwt-assertion"], token)
            : sessions.refresh(token, csrf, request.headers["cf-access-jwt-assertion"]);
          return HttpServerResponse.setCookieUnsafe(
            HttpServerResponse.jsonUnsafe(issued.session, { headers }),
            FoundrySessions.FOUNDRY_SESSION_COOKIE,
            issued.token,
            {
              ...cookieOptions,
              expires: DateTime.toDateUtc(DateTime.makeUnsafe(issued.session.expiresAt)),
            },
          );
        }).pipe(
          Effect.catchTags({
            FoundryAuthError: (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: error.code, message: error.message },
                  {
                    headers,
                    status:
                      error.code === "unavailable"
                        ? 503
                        : error.code === "invalid_access" || error.code === "invalid_session"
                          ? 401
                          : 403,
                  },
                ),
              ),
          }),
        ),
      );
    return Layer.mergeAll(route("login"), route("session"), route("refresh"), route("logout"));
  }),
);
