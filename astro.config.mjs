import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import solid from "@astrojs/solid-js";
import process from "node:process";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [solid()],
  server: { host: true, port: Number(process.env.PORT ?? 4321) },
  vite: { ssr: { noExternal: ["solid-js"] } },
});
