import type { APIRoute } from "astro";
import {
  AppError,
  errorResponse,
  notFoundResponse,
} from "../../../../server/errors";
import { runtime } from "../../../../server/runtime";
import { noStoreJson } from "../../../../server/schemas/api";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const id = params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return notFoundResponse();
    const job = runtime.jobs.getJob(id);
    if (!job) return notFoundResponse();
    if (job.state !== "SUCCEEDED") {
      throw new AppError(
        "RESULT_NOT_READY",
        "분석 결과가 아직 준비되지 않았습니다",
      );
    }
    const result = runtime.jobs.getResult(id);
    if (!result) return notFoundResponse();
    return noStoreJson(result);
  } catch (error) {
    return errorResponse(error);
  }
};
