import { parentPort } from "node:worker_threads";
import { AppError } from "../errors";
import { runAnalysis } from "./pipeline";

if (!parentPort) throw new Error("Analysis worker requires parentPort");

let active: { id: string; controller: AbortController } | null = null;
parentPort.postMessage({ type: "ready" });
parentPort.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as {
    type?: string;
    id?: string;
    canonicalLogin?: string;
  };
  const activeJob = active;
  if (value.type === "cancel" && activeJob && activeJob.id === value.id) {
    activeJob.controller.abort();
    return;
  }
  if (
    value.type !== "run" ||
    typeof value.id !== "string" ||
    typeof value.canonicalLogin !== "string" ||
    active
  ) {
    return;
  }
  const controller = new AbortController();
  active = { id: value.id, controller };
  void runAnalysis({
    id: value.id,
    canonicalLogin: value.canonicalLogin,
    signal: controller.signal,
    onProgress: (progress) =>
      parentPort?.postMessage({ type: "progress", id: value.id, progress }),
  })
    .then((result) =>
      parentPort?.postMessage({ type: "result", id: value.id, result }),
    )
    .catch((error: unknown) => {
      const known = error instanceof AppError;
      parentPort?.postMessage({
        type: "error",
        id: value.id,
        error: {
          code: known ? error.code : "ANALYSIS_FAILED",
          message: known ? error.publicMessage : "분석을 완료하지 못했습니다",
        },
      });
    })
    .finally(() => {
      active = null;
    });
});
