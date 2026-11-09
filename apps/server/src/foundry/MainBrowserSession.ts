import { AuthGrantScope, FoundryAuthError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as SessionStore from "../auth/SessionStore.ts";
import * as FoundrySessions from "./FoundrySessions.ts";

export class MainBrowserSession extends Context.Service<
  MainBrowserSession,
  {
    readonly cookieName: string;
    readonly ensure: (
      foundryToken: string,
      previous?: string,
    ) => Effect.Effect<SessionStore.IssuedSession | undefined, FoundryAuthError>;
    readonly revoke: (token: string | undefined) => Effect.Effect<void, FoundryAuthError>;
  }
>()("t3/foundry/MainBrowserSession") {}
const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const foundry = yield* FoundrySessions.FoundrySessions;
  const unavailable = () => Effect.fail(new FoundryAuthError({ code: "unavailable" }));
  const revoke = Effect.fn("MainBrowserSession.revoke")(function* (token: string | undefined) {
    if (!token) return;
    const current = yield* sessions.verify(token).pipe(Effect.option);
    if (current._tag === "Some" && current.value.subject.startsWith("foundry:"))
      yield* sessions.revoke(current.value.sessionId).pipe(Effect.catch(unavailable));
  });
  const ensure = Effect.fn("MainBrowserSession.ensure")(function* (
    foundryToken: string,
    previous?: string,
  ) {
    const session = yield* foundry.inspect(foundryToken);
    const subject = `foundry:${yield* foundry.reference(foundryToken)}`;
    if (previous) {
      const current = yield* sessions.verify(previous).pipe(Effect.option);
      if (current._tag === "Some" && current.value.subject === subject) return undefined;
    }
    yield* revoke(previous);
    const now = yield* Clock.currentTimeMillis;
    return yield* sessions
      .issue({
        subject,
        ttl: Duration.millis(session.expiresAt - now),
        method: "browser-session-cookie",
        scopes: AuthGrantScope.literals,
      })
      .pipe(Effect.catch(unavailable));
  });
  return MainBrowserSession.of({ cookieName: sessions.cookieName, ensure, revoke });
});
export const layer = Layer.effect(MainBrowserSession, make);
