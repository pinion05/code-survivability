import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { AppError, type ErrorCode } from "../errors";
import type { AnalysisResult } from "../schemas/result";
import { cleanupJobWorkspaces } from "../git/scanner";
import { LIMITS } from "../schemas/limits";
import type { ProgressUpdate } from "../analysis/pipeline";

type Pending = {
  id: string;
  resolve: (result: AnalysisResult) => void;
  reject: (error: Error) => void;
  onProgress: (progress: ProgressUpdate) => void;
  cleanup?: () => void;
};

export class WorkerManager {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private generation = 0;
  private ready = false;
  private stopping = false;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly workspaceRoot = process.env.WORKSPACE_ROOT?.trim() ||
      "/tmp/code-survivability",
  ) {
    this.prepareWorker();
  }

  isReady(): boolean {
    return this.ready && this.worker !== null && !this.stopping;
  }

  getGeneration(): number {
    return this.generation;
  }

  async run(
    id: string,
    canonicalLogin: string,
    signal: AbortSignal,
    onProgress: (progress: ProgressUpdate) => void,
  ): Promise<AnalysisResult> {
    if (this.stopping) {
      throw new AppError("NOT_READY", "분석 워커가 준비되지 않았습니다");
    }
    if (signal.aborted) {
      throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
    }
    await this.waitUntilReady(signal);
    if (signal.aborted) {
      throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
    }
    if (!this.worker || this.pending) {
      throw new AppError("NOT_READY", "분석 워커가 준비되지 않았습니다");
    }

    const worker = this.worker;
    return new Promise((resolvePromise, reject) => {
      let killTimer: NodeJS.Timeout | undefined;
      const abort = (): void => {
        worker.postMessage({ type: "cancel", id });
        killTimer = setTimeout(() => {
          if (this.pending?.id === id && this.worker === worker) {
            void worker.terminate();
          }
        }, 2_000);
        killTimer.unref();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        id,
        resolve: resolvePromise,
        reject,
        onProgress,
        cleanup: () => {
          signal.removeEventListener("abort", abort);
          if (killTimer) clearTimeout(killTimer);
        },
      };
      worker.postMessage({
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
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const pendingId = this.pending?.id ?? null;
    this.pending?.reject(
      new AppError("WORKER_CRASH", "분석 워커가 종료되었습니다"),
    );
    this.clearPending();
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    if (pendingId) {
      await cleanupJobWorkspaces(this.workspaceRoot, pendingId);
    }
  }

  private spawn(): void {
    if (this.stopping) return;
    this.generation += 1;
    this.ready = false;
    const workerUrl = pathToFileURL(
      resolve(process.cwd(), "src/server/analysis/worker.ts"),
    );
    const worker = new Worker(workerUrl, {
      execArgv: ["--import", "tsx"],
      resourceLimits: {
        maxOldGenerationSizeMb: LIMITS.workerOldGenerationMb,
        maxYoungGenerationSizeMb: LIMITS.workerYoungGenerationMb,
        stackSizeMb: LIMITS.workerStackMb,
      },
    });
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
      const interruptedJobId = this.pending?.id;
      this.ready = false;
      this.worker = null;
      this.pending?.reject(
        new AppError("WORKER_CRASH", "분석 워커가 비정상 종료되었습니다"),
      );
      this.clearPending();
      if (!this.stopping) this.prepareWorker(interruptedJobId);
    });
  }

  private async waitUntilReady(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + LIMITS.workerRecoveryMs;
    while (!this.isReady()) {
      if (signal.aborted) {
        throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
      }
      if (this.stopping || Date.now() >= deadline) {
        throw new AppError("NOT_READY", "분석 워커가 준비되지 않았습니다");
      }
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 25),
      );
    }
  }

  private prepareWorker(jobId?: string): void {
    void cleanupJobWorkspaces(this.workspaceRoot, jobId)
      .then(() => {
        if (!this.stopping && !this.worker) this.spawn();
      })
      .catch(() => {
        if (this.stopping) return;
        this.recoveryTimer = setTimeout(() => this.prepareWorker(jobId), 1_000);
        this.recoveryTimer.unref();
      });
  }
  private clearPending(): void {
    this.pending?.cleanup?.();
    this.pending = null;
  }
}
