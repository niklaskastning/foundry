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
  for (const headers of [
    { Authorization: "Bearer t3-token" },
    { authorization: "DPoP t3-token" },
  ]) {
    expect(authorizeInstanceRequest(origin, origin, headers, "opaque-token")).toEqual({
      cancel: true,
    });
  }
  expect(authorizeInstanceRequest(origin, origin, {}, undefined)).toEqual({ cancel: true });
});
