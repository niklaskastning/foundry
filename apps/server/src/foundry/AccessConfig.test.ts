import { expect, it } from "vite-plus/test";
import { isNativeOrigin, isDevelopmentLoopbackOrigin } from "./AccessConfig.ts";

it("allows native HTTP only on literal loopback origins", () => {
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://foundry.example",
  ])
    expect(isNativeOrigin(origin)).toBe(true);
  for (const origin of [
    "http://foundry.example",
    "http://localhost.example",
    "http://0.0.0.0:3000",
    "http://127.0.0.2:3000",
    "http://user@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?x=1",
    "http://localhost:3000/",
  ])
    expect(isNativeOrigin(origin)).toBe(false);
});

it("requires an exact literal loopback port for development machine transports", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:3000"])
    expect(isDevelopmentLoopbackOrigin(origin)).toBe(true);
  for (const origin of [
    "https://foundry.example",
    "http://localhost",
    "http://localhost:80",
    "http://localhost.example:3000",
    "http://127.0.0.2:3000",
    "http://0.0.0.0:3000",
    "http://user@localhost:3000",
    "http://localhost:3000/path",
    "http://localhost:3000?x=1",
    "http://localhost:3000#x",
    "http://localhost:3000/",
  ])
    expect(isDevelopmentLoopbackOrigin(origin)).toBe(false);
});
