import { spawn } from "node:child_process";
import { AppError } from "../errors";

export type SpawnLimits = {
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  signal?: AbortSignal;
  monitor?: () => Promise<boolean>;
  monitorMs?: number;
};

export async function spawnBounded(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    limits: SpawnLimits;
    stdin?: Buffer;
  },
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  if (options.limits.signal?.aborted) {
    throw new AppError("RUN_TIMEOUT", "분석 실행 시간이 초과되었습니다");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let limitError: AppError | null = null;

    const terminate = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The process may have exited between the PID check and signal.
      }
      setTimeout(() => {
        try {
          if (child.pid === undefined) return;
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The process may have exited before escalation.
        }
      }, 500).unref();
    };

    const timeout = setTimeout(() => {
      limitError = new AppError(
        "ANALYSIS_FAILED",
        "Git 명령 시간이 초과되었습니다",
      );
      terminate();
    }, options.limits.timeoutMs);
    const abort = (): void => {
      limitError = new AppError(
        "RUN_TIMEOUT",
        "분석 실행 시간이 초과되었습니다",
      );
      terminate();
    };
    options.limits.signal?.addEventListener("abort", abort, { once: true });
    let monitorTimer: NodeJS.Timeout | null = null;
    const runMonitor = async (): Promise<void> => {
      if (settled || !options.limits.monitor || limitError) return;
      try {
        if (await options.limits.monitor()) {
          limitError = new AppError(
            "WORKSPACE_LIMIT",
            "작업 공간 한도를 초과했습니다",
          );
          terminate();
          return;
        }
      } catch {
        limitError = new AppError(
          "ANALYSIS_FAILED",
          "작업 공간 사용량을 확인하지 못했습니다",
        );
        terminate();
        return;
      }
      if (!settled && !limitError) {
        monitorTimer = setTimeout(
          () => void runMonitor(),
          options.limits.monitorMs ?? 500,
        );
        monitorTimer.unref();
      }
    };
    if (options.limits.monitor) {
      monitorTimer = setTimeout(
        () => void runMonitor(),
        options.limits.monitorMs ?? 500,
      );
      monitorTimer.unref();
    }

    if (options.stdin) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.limits.stdoutBytes && !limitError) {
        limitError = new AppError(
          "ANALYSIS_FAILED",
          "Git 표준 출력 한도를 초과했습니다",
        );
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.limits.stderrBytes && !limitError) {
        limitError = new AppError(
          "ANALYSIS_FAILED",
          "Git 오류 출력 한도를 초과했습니다",
        );
        terminate();
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new AppError("ANALYSIS_FAILED", `Git 실행 실패: ${error.message}`),
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (limitError) return reject(limitError);
      if (code !== 0) {
        return reject(
          new AppError(
            "ANALYSIS_FAILED",
            `Git 명령이 실패했습니다 (${code ?? signal ?? "unknown"})`,
          ),
        );
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });

    function cleanup(): void {
      clearTimeout(timeout);
      if (monitorTimer) clearTimeout(monitorTimer);
      options.limits.signal?.removeEventListener("abort", abort);
    }
  });
}
