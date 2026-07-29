import { AppError } from "../errors";
import { LIMITS } from "./limits";

export async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new AppError(
      "INVALID_USERNAME",
      "Content-Type은 application/json이어야 합니다",
    );
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > LIMITS.requestBodyBytes) {
    throw new AppError(
      "REQUEST_TOO_LARGE",
      "요청 본문 크기 한도를 초과했습니다",
    );
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("INVALID_USERNAME", "요청 본문이 없습니다");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.requestBodyBytes) {
      await reader.cancel();
      throw new AppError(
        "REQUEST_TOO_LARGE",
        "요청 본문 크기 한도를 초과했습니다",
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new AppError(
      "INVALID_USERNAME",
      "JSON 요청 본문이 올바르지 않습니다",
    );
  }
}

export function noStoreJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(value, { ...init, headers });
}
