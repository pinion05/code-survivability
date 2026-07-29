import type { APIRoute } from "astro";
import { isReady } from "../server/runtime";

export const prerender = false;
export const GET: APIRoute = () => {
  const ready = isReady();
  return Response.json(
    { status: ready ? "ready" : "not_ready" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
};
