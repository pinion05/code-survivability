import type { APIRoute } from "astro";
import { clientKey } from "../../../../server/admission/client-key";
import {
  AppError,
  errorResponse,
  notFoundResponse,
} from "../../../../server/errors";
import { runtime } from "../../../../server/runtime";
import { noStoreJson } from "../../../../server/schemas/api";

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  try {
    const id = params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return notFoundResponse();
    runtime.admission.admitPoll(clientKey(request));
    const job = runtime.jobs.getJob(id);
    if (!job) return notFoundResponse();
    return noStoreJson({
      jobId: job.id,
      state: job.state,
      phase: job.phase,
      progress: job.progress,
      coverageWarnings: job.coverageWarnings,
      createdAt: new Date(job.createdAt).toISOString(),
      queueDeadline: job.queueDeadline
        ? new Date(job.queueDeadline).toISOString()
        : null,
      runDeadline: job.runDeadline
        ? new Date(job.runDeadline).toISOString()
        : null,
      resultUrl:
        job.state === "SUCCEEDED" ? `/api/analyses/${job.id}/result` : null,
      shareUrl: job.state === "SUCCEEDED" ? `/r/${job.id}` : null,
      error: job.error,
    });
  } catch (error) {
    const response = errorResponse(error);
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      response.headers.set("Retry-After", "2");
    }
    return response;
  }
};
