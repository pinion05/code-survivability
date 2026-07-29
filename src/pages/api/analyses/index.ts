import type { APIRoute } from "astro";
import { clientKey } from "../../../server/admission/client-key";
import { getConfig } from "../../../server/config";
import { AppError, errorResponse } from "../../../server/errors";
import {
  canonicalizeUser,
  validateUsername,
} from "../../../server/github/canonical-user";
import { GitHubClient } from "../../../server/github/client";
import { runtime, isReady } from "../../../server/runtime";
import { noStoreJson, readBoundedJson } from "../../../server/schemas/api";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let reservation: string | null = null;
  try {
    const config = getConfig();
    const origin = request.headers.get("origin");
    if (
      origin &&
      new URL(origin).origin !== new URL(config.PUBLIC_ORIGIN).origin
    ) {
      return Response.json(
        {
          error: {
            code: "FORBIDDEN_ORIGIN",
            message: "허용되지 않은 요청 출처입니다",
          },
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = await readBoundedJson(request);
    const username = validateUsername(
      (body as { username?: unknown })?.username,
    );
    if (!isReady())
      throw new AppError("NOT_READY", "분석 서비스가 준비되지 않았습니다");
    const key = clientKey(request);
    runtime.admission.admitCreation(key);

    const known = runtime.jobs.lookupKnownAlias(username);
    if (known) return submissionResponse(known, true);

    reservation = runtime.jobs.reserve(key);
    const user = await canonicalizeUser(
      new GitHubClient(config.GITHUB_TOKEN),
      username,
      request.signal,
    );
    const finalized = runtime.jobs.finalizeReservation(
      reservation,
      username,
      user.login,
    );
    reservation = null;
    return submissionResponse(finalized, finalized.deduplicated);
  } catch (error) {
    if (reservation) runtime.jobs.releaseReservation(reservation);
    return errorResponse(error);
  }
};

function submissionResponse(
  value: ReturnType<typeof runtime.jobs.finalizeReservation>,
  deduplicated: boolean,
): Response {
  const { job, cached } = value;
  return noStoreJson(
    {
      jobId: job.id,
      canonicalLogin: job.canonicalLogin,
      state: job.state,
      deduplicated,
      statusUrl: `/api/analyses/${job.id}/status`,
      resultUrl: cached ? `/api/analyses/${job.id}/result` : null,
      shareUrl: cached ? `/r/${job.id}` : null,
    },
    { status: cached ? 200 : 202 },
  );
}
