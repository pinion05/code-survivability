import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { AppError, type ErrorCode } from "../errors";
import type { AnalysisResult } from "../schemas/result";
import type { ProgressUpdate } from "../analysis/pipeline";

type Pending = {
  id: string;
  resolve: (result: AnalysisResult) => void;
  reject: (error: Error) => void;
  onProgress: (progress: ProgressUpdate) => void;
  abort?: () => void;
};

export class WorkerManager {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private generation = 0;
  private ready = false;
  private stopping = false;

  constructor() {
    this.spawn();
  }

  isReady(): boolean {
    return this.ready && this.worker !== null && !this.stopping;
  }

  getGeneration(): number {
    return this.generation;
  }

  run(
    id: string,
    canonicalLogin: string,
    signal: AbortSignal,
    onProgress: (progress: ProgressUpdate) => void,
  ): Promise<AnalysisResult> {
    if (!this.isReady() || !this.worker || this.pending) {
      return Promise.reject(
        new AppError("NOT_READY", "분석 워커가 준비되지 않았습니다"),
      );
    }
    return new Promise((resolvePromise, reject) => {
      const abort = (): void =>
        this.worker?.postMessage({ type: "cancel", id });
      signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        id,
        resolve: resolvePromise,
        reject,
        onProgress,
        abort: () => signal.removeEventListener("abort", abort),
      };
      this.worker?.postMessage({
        type: "run",
        id,
        canonicalLogin,
        generation: this.generation,
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.pending?.reject(
      new AppError("WORKER_CRASH", "분석 워커가 종료되었습니다"),
    );
    this.clearPending();
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }

  private spawn(): void {
    if (this.stopping) return;
    this.generation += 1;
    this.ready = false;
    const workerUrl = pathToFileURL(
      resolve(process.cwd(), "src/server/analysis/worker.ts"),
    );
    const worker = new Worker(workerUrl, { execArgv: ["--import", "tsx"] });
    this.worker = worker;
    const generation = this.generation;
    worker.on("message", (message: unknown) => {
      if (
        generation !== this.generation ||
        !message ||
        typeof message !== "object"
      )
        return;
      const value = message as any;
      if (value.type === "ready") {
        this.ready = true;
        return;
      }
      if (!this.pending || value.id !== this.pending.id) return;
      if (value.type === "progress") {
        this.pending.onProgress(value.progress as ProgressUpdate);
      } else if (value.type === "result") {
        this.pending.resolve(value.result as AnalysisResult);
        this.clearPending();
      } else if (value.type === "error") {
        this.pending.reject(
          new AppError(
            (value.error?.code ?? "ANALYSIS_FAILED") as ErrorCode,
            String(value.error?.message ?? "분석을 완료하지 못했습니다"),
          ),
        );
        this.clearPending();
      }
    });
    worker.on("error", () => undefined);
    worker.on("exit", () => {
      if (generation !== this.generation) return;
      this.ready = false;
      this.worker = null;
      this.pending?.reject(
        new AppError("WORKER_CRASH", "분석 워커가 비정상 종료되었습니다"),
      );
      this.clearPending();
      if (!this.stopping) setTimeout(() => this.spawn(), 100).unref();
    });
  }

  private clearPending(): void {
    this.pending?.abort?.();
    this.pending = null;
  }
}
