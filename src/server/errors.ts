export type ErrorCode =
  | "INVALID_USERNAME"
  | "REQUEST_TOO_LARGE"
  | "USER_NOT_FOUND"
  | "RATE_LIMITED"
  | "CLIENT_JOB_LIMIT"
  | "CAPACITY_FULL"
  | "NOT_READY"
  | "SHUTTING_DOWN"
  | "GITHUB_UNAVAILABLE"
  | "GITHUB_RESPONSE_LIMIT"
  | "RESULT_NOT_READY"
  | "NOT_FOUND"
  | "QUEUE_TIMEOUT"
  | "RUN_TIMEOUT"
  | "WORKER_CRASH"
  | "WORKSPACE_LIMIT"
  | "INTERNAL_INVARIANT"
  | "RESULT_TOO_LARGE"
  | "ANALYSIS_FAILED";

const STATUS: Record<ErrorCode, number> = {
  INVALID_USERNAME: 400,
  REQUEST_TOO_LARGE: 413,
  USER_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CLIENT_JOB_LIMIT: 429,
  CAPACITY_FULL: 429,
  NOT_READY: 503,
  SHUTTING_DOWN: 503,
  GITHUB_UNAVAILABLE: 502,
  GITHUB_RESPONSE_LIMIT: 502,
  RESULT_NOT_READY: 409,
  NOT_FOUND: 404,
  QUEUE_TIMEOUT: 408,
  RUN_TIMEOUT: 504,
  WORKER_CRASH: 500,
  WORKSPACE_LIMIT: 507,
  INTERNAL_INVARIANT: 500,
  RESULT_TOO_LARGE: 500,
  ANALYSIS_FAILED: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;

  constructor(code: ErrorCode, message: string, status = STATUS[code]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.publicMessage = message.slice(0, 256);
  }
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof AppError;
  const code = known ? error.code : "ANALYSIS_FAILED";
  const message = known ? error.publicMessage : "요청을 처리하지 못했습니다";
  const status = known ? error.status : 500;
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const notFoundResponse = (): Response =>
  Response.json(
    { error: { code: "NOT_FOUND", message: "Analysis not found" } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
