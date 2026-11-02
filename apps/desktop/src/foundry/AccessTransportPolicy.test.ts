import { expect, it } from "vite-plus/test";
import { authorizeInstanceRequest } from "./AccessTransportPolicy.ts";

it("shares the Access credential only with the exact HTTPS/WSS instance and preserves T3 cookies", () => {
  const origin = "https://foundry.example";
  for (const address of [`${origin}/api/test`, "wss://foundry.example/ws?wsTicket=t3-ticket"]) {
    expect(
      authorizeInstanceRequest(origin, address, { Cookie: "t3-session=value" }, "opaque-token"),
    ).toEqual({
      requestHeaders: { Cookie: "t3-session=value", Authorization: "Bearer opaque-token" },
    });
  }
  for (const address of [
    "https://foundry.example.attacker.test",
    "https://other.example/api",
    "https://foundry.example:8443/api",
    "ws://foundry.example/ws",
    "http://foundry.example/api",
    "file:///etc/passwd",
    "https://user@foundry.example/api",
    "invalid",
  ]) {
    expect(authorizeInstanceRequest(origin, address, {}, "opaque-token")).toEqual({ cancel: true });
  }
  for (const address of [`${origin}/api/auth/websocket-ticket/rpc`, "wss://foundry.example/ws"]) {
    expect(
      authorizeInstanceRequest(
        origin,
        address,
        {
          authorization: "Bearer t3-token",
          Cookie: "__Host-foundry_session=foundry; t3_session_main=old; other=keep",
        },
        "opaque-token",
        "t3_session_main",
      ),
    ).toEqual({
      requestHeaders: {
        Cookie: "__Host-foundry_session=foundry; other=keep; t3_session_main=t3-token",
        Authorization: "Bearer opaque-token",
      },
    });
  }
  for (const headers of [
    { authorization: "DPoP t3-token" },
    { Authorization: "Basic t3-token" },
    { Authorization: "Bearer bad;cookie=value" },
    { Authorization: "Bearer t3-token", authorization: "Bearer other" },
    { Authorization: "Bearer t3-token", DPoP: "proof" },
  ]) {
    expect(
      authorizeInstanceRequest(origin, origin, headers, "opaque-token", "t3_session_main"),
    ).toEqual({
      cancel: true,
    });
  }
  expect(authorizeInstanceRequest(origin, origin, {}, undefined)).toEqual({ cancel: true });
});

it("refuses bearer adaptation without a verified T3 cookie name or outside the instance", () => {
  for (const cookieName of [undefined, "__Host-foundry_session", "t3_session_main; injected", ""]) {
    expect(
      authorizeInstanceRequest(
        "https://foundry.example",
        "https://foundry.example/api/test",
        { Authorization: "Bearer t3-token" },
        "access-token",
        cookieName,
      ),
    ).toEqual({ cancel: true });
  }
  expect(
    authorizeInstanceRequest(
      "https://foundry.example",
      "https://other.example/api/test",
      { Authorization: "Bearer t3-token" },
      "access-token",
      "t3_session_main",
    ),
  ).toEqual({ cancel: true });
});
