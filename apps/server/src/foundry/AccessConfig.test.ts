import { expect, it } from "vite-plus/test";
import { isNativeOrigin } from "./AccessConfig.ts";

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
