import { expect, it } from "vite-plus/test";
import { discoverFactoryHome, factoryReturnPath } from "./home";

it("chooses the advertised factory home and preserves standalone T3", async () => {
  const descriptor = {
    protocolVersion: "1",
    instanceId: "11111111-1111-4111-8111-111111111111",
    mainEnvironmentId: "22222222-2222-4222-8222-222222222222",
    capabilities: ["foundry.instance-descriptor"],
    negotiatedCapabilities: [],
    auth: { bootstrapMethods: ["one-time-token"], sessionMethods: ["browser-session-cookie"] },
  };
  for (const [response, expected] of [
    [new Response(null, { status: 404 }), false],
    [new Response("<!doctype html>", { headers: { "content-type": "text/html" } }), false],
    [Response.json(descriptor), false],
    [Response.json({ ...descriptor, automation: { protocolVersion: "1" } }), true],
  ] as const) {
    expect(
      await discoverFactoryHome(
        "https://instance.example/.well-known/foundry",
        async () => response,
      ),
    ).toBe(expected);
  }
});

it("does not silently enter chats when discovery fails or returns invalid data", async () => {
  for (const response of [
    new Response(null, { status: 503 }),
    Response.json({ automation: { protocolVersion: "1" } }),
  ]) {
    await expect(
      discoverFactoryHome("https://instance.example/.well-known/foundry", async () => response),
    ).rejects.toThrow();
  }
});

it("keeps factory work and run context through pairing without accepting external return targets", () => {
  expect(
    factoryReturnPath(
      "/foundry?view=factories&factoryId=f&workItemId=w&runId=r&tab=runs&attemptId=a&token=secret",
    ),
  ).toBe("/foundry?view=factories&factoryId=f&workItemId=w&runId=r&attemptId=a&tab=runs");
  for (const target of [
    undefined,
    "https://other.example/foundry",
    "//other.example/foundry",
    "/foundry-other",
    "/chats",
    "/foundry\\other",
  ])
    expect(factoryReturnPath(target)).toBe("/");
});
