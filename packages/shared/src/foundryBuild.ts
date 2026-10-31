declare const __T3CODE_FOUNDRY_BUILD__: boolean | undefined;

export function isFoundryBuild(): boolean {
  return typeof __T3CODE_FOUNDRY_BUILD__ !== "undefined" && __T3CODE_FOUNDRY_BUILD__;
}

export function foundryDesktopScheme(development = false): string {
  return isFoundryBuild()
    ? development
      ? "t3foundry-dev"
      : "t3foundry"
    : development
      ? "t3code-dev"
      : "t3code";
}

declare const __T3CODE_FOUNDRY_HOSTED_APP_URL__: string | undefined;

export function foundryHostedAppUrl(): string {
  return typeof __T3CODE_FOUNDRY_HOSTED_APP_URL__ === "undefined"
    ? ""
    : __T3CODE_FOUNDRY_HOSTED_APP_URL__;
}
