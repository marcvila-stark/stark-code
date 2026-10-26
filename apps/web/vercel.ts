import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: { deploymentEnabled: false },
  buildCommand: "vp run --filter @starkfuture/web build",
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
