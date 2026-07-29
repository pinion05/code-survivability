import { randomUUID } from "node:crypto";
import { AppError, type ErrorCode } from "../errors";
import { analysisFingerprint } from "../cache/fingerprint";
import { WeightedLru } from "../cache/weighted-lru";
import { LIMITS } from "../schemas/limits";
import type { AnalysisResult } from "../schemas/result";
import type { ProgressUpdate } from "../analysis/pipeline";

export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "QUEUE_TIMEOUT"
  | "RUN_TIMEOUT"
  | "WORKER_CRASH"
  | "CANCELLED_SHUTDOWN";

export type JobRecord = {
  id: string;
  canonicalLogin: string;
  dedupeKey: string;
  clientKey: string;
  state: JobState;
  phase: string;
  progress: { completedUnits: number; totalUnits: number };
  coverageWarnings: number;
  createdAt: number;
  queueDeadline: number | null;
  runDeadline: number | null;
  terminalAt: number | null;
  resultId: string | null;
  error: { code: ErrorCode; message: string } | null;
  generation: number;
};

export type Runner = (
  id: string,
  canonicalLogin: string,
  signal: AbortSignal,
  onProgress: (progress: ProgressUpdate) => void,
) => Promise<AnalysisResult>;

export type FinalizeResult = {
  job: JobRecord;
  deduplicated: boolean;
  cached: boolean;
};

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly dedupe = new Map<string, string>();
  private readonly reservations = new Map<string, string>();
  private readonly results: WeightedLru<AnalysisResult>;
  private runningId: string | null = null;
  private waitingId: string | null = null;
  private shuttingDown = false;
  private runningController: AbortController | null = null;
  private runningCompletion: Promise<void> | null = null;

  constructor(
    private readonly runner: Runner,
    private readonly generation: () => number = () => 1,
    private readonly now: () => number = Date.now,
  ) {
    this.results = new WeightedLru(LIMITS.cacheEntries, LIMITS.cacheBytes, now);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  lookupKnownAlias(rawAlias: string): FinalizeResult | null {
    this.sweep();
    const canonical = this.aliases.get(rawAlias.toLowerCase());
    if (!canonical) return null;
    return this.lookupDedupe(analysisFingerprint(canonical));
  }

  reserve(clientKey: string): string {
    this.sweep();
    if (this.shuttingDown)
      throw new AppError("SHUTTING_DOWN", "서버가 종료 중입니다");
    const existingClient = [...this.jobs.values()].some(
      (job) =>
        job.clientKey === clientKey &&
        (job.state === "RUNNING" || job.state === "QUEUED"),
    );
    if (existingClient) {
      throw new AppError(
        "CLIENT_JOB_LIMIT",
        "클라이언트별 동시 분석 한도를 초과했습니다",
      );
    }
    const occupied =
      Number(this.runningId !== null) +
      Number(this.waitingId !== null) +
      this.reservations.size;
    if (occupied >= 2) {
      throw new AppError("CAPACITY_FULL", "현재 분석 대기열이 가득 찼습니다");
    }
    const token = randomUUID();
    this.reservations.set(token, clientKey);
    return token;
  }

  releaseReservation(token: string): void {
    this.reservations.delete(token);
  }

  finalizeReservation(
    token: string,
    rawAlias: string,
    canonicalLogin: string,
  ): FinalizeResult {
    this.sweep();
    const clientKey = this.reservations.get(token);
    if (!clientKey)
      throw new AppError("CAPACITY_FULL", "분석 예약이 만료되었습니다");
    const dedupeKey = analysisFingerprint(canonicalLogin);
    this.aliases.set(rawAlias.toLowerCase(), canonicalLogin);
    this.aliases.set(canonicalLogin.toLowerCase(), canonicalLogin);
    const existing = this.lookupDedupe(dedupeKey);
    if (existing) {
      this.reservations.delete(token);
      return { ...existing, deduplicated: true };
    }

    const id = randomUUID();
    const state: JobState = this.runningId === null ? "RUNNING" : "QUEUED";
    const now = this.now();
    const job: JobRecord = {
      id,
      canonicalLogin,
      dedupeKey,
      clientKey,
      state,
      phase: state === "RUNNING" ? "STARTING" : "QUEUED",
      progress: { completedUnits: 0, totalUnits: 1 },
      coverageWarnings: 0,
      createdAt: now,
      queueDeadline: state === "QUEUED" ? now + LIMITS.queueMs : null,
      runDeadline: state === "RUNNING" ? now + LIMITS.runMs : null,
      terminalAt: null,
      resultId: null,
      error: null,
      generation: this.generation(),
    };
    this.reservations.delete(token);
    this.jobs.set(id, job);
    this.dedupe.set(dedupeKey, id);
    if (state === "RUNNING") {
      this.runningId = id;
      this.execute(job);
    } else {
      this.waitingId = id;
      this.armQueueTimeout(job);
    }
    return { job, deduplicated: false, cached: false };
  }

  getJob(id: string): JobRecord | null {
    this.sweep();
    return this.jobs.get(id) ?? null;
  }

  getResult(id: string): AnalysisResult | null {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.state !== "SUCCEEDED" || !job.resultId) return null;
    const result = this.results.get(job.resultId);
    if (!result) {
      this.jobs.delete(id);
      this.dedupe.delete(job.dedupeKey);
      return null;
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.reservations.clear();
    if (this.waitingId) {
      const waiting = this.jobs.get(this.waitingId);
      if (waiting)
        this.terminal(
          waiting,
          "CANCELLED_SHUTDOWN",
          "SHUTTING_DOWN",
          "서버 종료로 취소되었습니다",
        );
      this.waitingId = null;
    }

    const running = this.runningId ? this.jobs.get(this.runningId) : null;
    if (running?.state === "RUNNING") {
      this.terminal(
        running,
        "CANCELLED_SHUTDOWN",
        "SHUTTING_DOWN",
        "서버 종료로 취소되었습니다",
      );
    }
    this.runningController?.abort();
    const completion = this.runningCompletion;
    if (completion) {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
      ]);
    }
    this.runningId = null;
  }

  private lookupDedupe(dedupeKey: string): FinalizeResult | null {
    const id = this.dedupe.get(dedupeKey);
    if (!id) return null;
    const job = this.jobs.get(id);
    if (!job) {
      this.dedupe.delete(dedupeKey);
      return null;
    }
    if (job.state === "SUCCEEDED") {
      if (!job.resultId || !this.results.has(job.resultId)) {
        this.dedupe.delete(dedupeKey);
        this.jobs.delete(id);
        return null;
      }
      return { job, deduplicated: true, cached: true };
    }
    if (job.state === "RUNNING" || job.state === "QUEUED") {
      return { job, deduplicated: true, cached: false };
    }
    return null;
  }

  private execute(job: JobRecord): void {
    const controller = new AbortController();
    this.runningController = controller;
    const timeout = setTimeout(() => {
      if (job.state !== "RUNNING") return;
      controller.abort();
      this.terminal(
        job,
        "RUN_TIMEOUT",
        "RUN_TIMEOUT",
        "분석 실행 시간이 초과되었습니다",
      );
    }, LIMITS.runMs);
    const completion = this.runner(
      job.id,
      job.canonicalLogin,
      controller.signal,
      (progress) => {
        if (job.state !== "RUNNING" || job.generation !== this.generation())
          return;
        if (progress.completedUnits < job.progress.completedUnits) return;
        job.phase = progress.phase;
        job.progress = {
          completedUnits: progress.completedUnits,
          totalUnits: Math.max(progress.totalUnits, progress.completedUnits),
        };
        job.coverageWarnings = Math.max(
          job.coverageWarnings,
          progress.coverageWarnings,
        );
      },
    )
      .then((result) => {
        if (job.state !== "RUNNING") return;
        const weight = Buffer.byteLength(JSON.stringify(result)) + 512;
        if (!this.results.set(job.id, result, weight, LIMITS.resultTtlMs)) {
          throw new AppError(
            "RESULT_TOO_LARGE",
            "분석 결과 캐시 한도를 초과했습니다",
          );
        }
        job.state = "SUCCEEDED";
        job.phase = "COMPLETE";
        job.resultId = job.id;
        job.terminalAt = this.now();
      })
      .catch((error: unknown) => {
        if (job.state !== "RUNNING") return;
        const known = error instanceof AppError;
        this.terminal(
          job,
          known && error.code === "WORKER_CRASH" ? "WORKER_CRASH" : "FAILED",
          known ? error.code : "ANALYSIS_FAILED",
          known ? error.publicMessage : "분석을 완료하지 못했습니다",
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.runningController === controller)
          this.runningController = null;
        if (this.runningCompletion === completion)
          this.runningCompletion = null;
        if (this.runningId === job.id) {
          this.runningId = null;
          this.promote();
        }
      });
    this.runningCompletion = completion;
  }

  private promote(): void {
    if (this.shuttingDown || this.runningId || !this.waitingId) return;
    const job = this.jobs.get(this.waitingId);
    this.waitingId = null;
    if (!job || job.state !== "QUEUED") return;
    job.state = "RUNNING";
    job.phase = "STARTING";
    job.queueDeadline = null;
    job.runDeadline = this.now() + LIMITS.runMs;
    job.generation = this.generation();
    this.runningId = job.id;
    this.execute(job);
  }

  private armQueueTimeout(job: JobRecord): void {
    setTimeout(() => {
      if (job.state !== "QUEUED") return;
      this.terminal(
        job,
        "QUEUE_TIMEOUT",
        "QUEUE_TIMEOUT",
        "대기열 시간이 초과되었습니다",
      );
      if (this.waitingId === job.id) this.waitingId = null;
    }, LIMITS.queueMs).unref();
  }

  private terminal(
    job: JobRecord,
    state: JobState,
    code: ErrorCode,
    message: string,
  ): void {
    job.state = state;
    job.phase = state;
    job.terminalAt = this.now();
    job.error = { code, message };
    this.dedupe.delete(job.dedupeKey);
  }

  private sweep(): void {
    this.results.sweep();
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (!job.terminalAt) continue;
      const ttl =
        job.state === "SUCCEEDED" ? LIMITS.statusTtlMs : LIMITS.failureTtlMs;
      if (
        job.terminalAt + ttl <= now ||
        (job.state === "SUCCEEDED" && !this.results.has(id))
      ) {
        this.jobs.delete(id);
        if (this.dedupe.get(job.dedupeKey) === id)
          this.dedupe.delete(job.dedupeKey);
      }
    }
  }
}
