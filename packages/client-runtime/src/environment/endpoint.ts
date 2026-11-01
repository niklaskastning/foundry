export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const gateway = /^\/api\/foundry\/gateway\/devices\/[^/]+\//.exec(url.pathname)?.[0];
  url.pathname = gateway ? `${gateway}${pathname.replace(/^\//, "")}` : pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};
