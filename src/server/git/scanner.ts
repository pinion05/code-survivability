import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";
import { isEligiblePath, normalizeLine } from "../analysis/normalize";
import type { CurrentPath } from "../analysis/metrics";
import { spawnBounded } from "./spawn";

export type SnapshotResult = {
  authoritativeOid: string;
  currentPaths: Map<string, CurrentPath>;
  unavailableOriginalPaths: Set<string>;
  repositoryCounts: Map<string, number> | null;
  coverageReasons: string[];
};

type TreeEntry = { mode: string; oid: string; size: number; path: string };

export class GitSnapshotScanner {
  private processCount = 0;
  private totalGitMs = 0;
  private totalBlobBytes = 0;
  private totalTreeEntries = 0;
  private totalLines = 0;
  private totalStoredOccurrences = 0;
  private totalStoredOccurrenceBytes = 0;

  constructor(
    private readonly root: string,
    private readonly thresholdBytes: number,
  ) {}

  async scan(input: {
    jobId: string;
    owner: string;
    repo: string;
    defaultBranch: string;
    requestedLineCounts: Map<string, Map<string, number>>;
    signal?: AbortSignal;
  }): Promise<SnapshotResult> {
    validateRepositoryName(input.owner);
    validateRepositoryName(input.repo);
    validateBranch(input.defaultBranch);
    const requestedPaths = new Set(input.requestedLineCounts.keys());
    const repositoryTargets = new Map<string, string>();
    let requestedOccurrenceBudget = 0;
    let requestedOccurrenceBytes = 0;
    let normalizedEntryBytes = 0;
    for (const counts of input.requestedLineCounts.values()) {
      for (const [line, count] of counts) {
        if (!line || !Number.isSafeInteger(count) || count <= 0) {
          throw new AppError(
            "ANALYSIS_FAILED",
            "요청된 줄 발생 횟수가 올바르지 않습니다",
          );
        }
        const bytes = Buffer.byteLength(line, "utf8");
        if (!repositoryTargets.has(line)) {
          repositoryTargets.set(line, line);
          normalizedEntryBytes += bytes;
        }
        requestedOccurrenceBudget += count;
        requestedOccurrenceBytes += bytes * count;
      }
    }
    if (
      requestedOccurrenceBudget > LIMITS.storedOccurrences ||
      requestedOccurrenceBytes > LIMITS.storedOccurrenceBytes ||
      repositoryTargets.size > LIMITS.normalizedEntriesPerRepository ||
      normalizedEntryBytes > LIMITS.normalizedEntryBytesPerRepository
    ) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "요청된 줄 증거 한도를 초과했습니다",
      );
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.preflight();
    const workspace = await mkdtemp(
      join(this.root, jobWorkspacePrefix(input.jobId)),
    );
    const bare = join(workspace, "repository.git");
    const home = join(workspace, "home");
    const hooks = join(workspace, "hooks");
    const askpass = join(workspace, "askpass.sh");
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(hooks, { mode: 0o700 }),
    ]);
    await writeFile(askpass, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await chmod(askpass, 0o700);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      GIT_PROTOCOL_FROM_USER: "0",
      GIT_NO_LAZY_FETCH: "1",
    };
    const baseArgs = [
      "-c",
      "credential.helper=",
      "-c",
      `core.hooksPath=${hooks}`,
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.ssh.allow=never",
      "-c",
      "protocol.git.allow=never",
      "-c",
      "protocol.http.allow=always",
      "-c",
      "protocol.https.allow=always",
    ];

    try {
      await this.git(
        workspace,
        env,
        [...baseArgs, "init", "--bare", bare],
        input.signal,
        workspace,
      );
      const publicUrl = `https://github.com/${input.owner}/${input.repo}.git`;
      await this.git(
        workspace,
        env,
        [
          ...baseArgs,
          `--git-dir=${bare}`,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          publicUrl,
          `refs/heads/${input.defaultBranch}`,
        ],
        input.signal,
        workspace,
      );
      const oidOutput = await this.git(
        workspace,
        env,
        [
          ...baseArgs,
          `--git-dir=${bare}`,
          "rev-parse",
          "--verify",
          "FETCH_HEAD",
        ],
        input.signal,
        workspace,
      );
      const authoritativeOid = oidOutput.stdout.toString("ascii").trim();
      if (!/^[0-9a-f]{40,64}$/.test(authoritativeOid)) {
        throw new AppError(
          "ANALYSIS_FAILED",
          "가져온 Git OID가 올바르지 않습니다",
        );
      }
      const treeOutput = await this.git(
        workspace,
        env,
        [
          ...baseArgs,
          `--git-dir=${bare}`,
          "ls-tree",
          "-r",
          "-z",
          "--long",
          authoritativeOid,
        ],
        input.signal,
        workspace,
      );
      const entries = parseTree(treeOutput.stdout);
      if (entries.length > LIMITS.treeEntriesPerRepository) {
        throw new AppError(
          "ANALYSIS_FAILED",
          "저장소 트리 항목 한도를 초과했습니다",
        );
      }
      this.totalTreeEntries += entries.length;
      if (this.totalTreeEntries > LIMITS.treeEntries) {
        throw new AppError(
          "ANALYSIS_FAILED",
          "분석 전체 트리 항목 한도를 초과했습니다",
        );
      }
      const entryPaths = new Set(entries.map((entry) => entry.path));
      const currentPaths = new Map<string, CurrentPath>();
      const unavailableOriginalPaths = new Set<string>();
      const repositoryCounts = new Map<string, number>();
      const coverageReasons: string[] = [];
      const coverageReasonSet = new Set<string>();
      let repositoryComplete = true;
      let repositoryBlobBytes = 0;
      let blobCount = 0;
      const selectedEntries: TreeEntry[] = [];
      const addCoverageReason = (code: string): void => {
        if (coverageReasonSet.has(code)) return;
        coverageReasonSet.add(code);
        coverageReasons.push(code);
      };

      for (const entry of entries) {
        if (!isEligiblePath(entry.path)) continue;
        const requested = requestedPaths.has(entry.path);
        if (blobCount >= LIMITS.blobsPerRepository) {
          repositoryComplete = false;
          addCoverageReason("BLOB_COUNT_LIMIT");
          if (requested) unavailableOriginalPaths.add(entry.path);
          continue;
        }
        blobCount += 1;
        if (entry.size > LIMITS.blobBytes) {
          repositoryComplete = false;
          addCoverageReason("BLOB_SIZE_LIMIT");
          if (requested) unavailableOriginalPaths.add(entry.path);
          continue;
        }
        if (
          repositoryBlobBytes + entry.size > LIMITS.blobBytesPerRepository ||
          this.totalBlobBytes + entry.size > LIMITS.blobBytesTotal
        ) {
          repositoryComplete = false;
          addCoverageReason("BLOB_BYTES_LIMIT");
          if (requested) unavailableOriginalPaths.add(entry.path);
          continue;
        }
        repositoryBlobBytes += entry.size;
        this.totalBlobBytes += entry.size;
        selectedEntries.push(entry);
      }

      let repositoryLines = 0;
      let stopRepository = false;
      const markRequestedUnavailable = (): void => {
        for (const path of requestedPaths) unavailableOriginalPaths.add(path);
      };
      for (const batch of partitionBlobEntries(selectedEntries)) {
        if (stopRepository) break;
        const blobs = await this.readBlobs(
          workspace,
          bare,
          env,
          baseArgs,
          batch,
          input.signal,
        );
        for (const entry of batch) {
          const requestedCounts = input.requestedLineCounts.get(entry.path);
          const requested = requestedCounts !== undefined;
          const blob = blobs.get(entry.oid);
          if (!blob) {
            repositoryComplete = false;
            addCoverageReason("BLOB_UNAVAILABLE");
            if (requested) unavailableOriginalPaths.add(entry.path);
            continue;
          }
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(blob);
          } catch {
            repositoryComplete = false;
            addCoverageReason("BLOB_ENCODING_UNAVAILABLE");
            if (requested) unavailableOriginalPaths.add(entry.path);
            continue;
          }
          const lines = text.split("\n");
          if (lines.length > LIMITS.linesPerBlob) {
            repositoryComplete = false;
            addCoverageReason("BLOB_LINE_LIMIT");
            if (requested) unavailableOriginalPaths.add(entry.path);
            continue;
          }
          if (repositoryLines + lines.length > LIMITS.linesPerRepository) {
            repositoryComplete = false;
            addCoverageReason("REPOSITORY_LINE_LIMIT");
            markRequestedUnavailable();
            stopRepository = true;
            break;
          }
          if (this.totalLines + lines.length > LIMITS.linesTotal) {
            repositoryComplete = false;
            addCoverageReason("ANALYSIS_LINE_LIMIT");
            markRequestedUnavailable();
            stopRepository = true;
            break;
          }
          repositoryLines += lines.length;
          this.totalLines += lines.length;

          const occurrences: CurrentPath["occurrences"] = [];
          const collected = new Map<string, number>();
          for (let index = 0; index < lines.length; index += 1) {
            const line = normalizeLine(lines[index] ?? "");
            if (!line) continue;
            const canonicalLine = repositoryTargets.get(line);
            if (canonicalLine !== undefined) {
              if (
                repositoryCounts.has(canonicalLine) ||
                repositoryCounts.size < LIMITS.normalizedEntriesPerRepository
              ) {
                repositoryCounts.set(
                  canonicalLine,
                  (repositoryCounts.get(canonicalLine) ?? 0) + 1,
                );
              } else {
                repositoryComplete = false;
                addCoverageReason("NORMALIZED_ENTRY_LIMIT");
              }
            }

            const expected =
              canonicalLine === undefined
                ? 0
                : (requestedCounts?.get(canonicalLine) ?? 0);
            const retained =
              canonicalLine === undefined
                ? 0
                : (collected.get(canonicalLine) ?? 0);
            if (expected <= retained) continue;
            const occurrenceBytes = Buffer.byteLength(
              canonicalLine ?? line,
              "utf8",
            );
            if (
              this.totalStoredOccurrences >= LIMITS.storedOccurrences ||
              this.totalStoredOccurrenceBytes + occurrenceBytes >
                LIMITS.storedOccurrenceBytes
            ) {
              unavailableOriginalPaths.add(entry.path);
              addCoverageReason("STORED_OCCURRENCE_LIMIT");
              continue;
            }
            occurrences.push({
              line: canonicalLine ?? line,
              lineNumber: index + 1,
            });
            collected.set(canonicalLine ?? line, retained + 1);
            this.totalStoredOccurrences += 1;
            this.totalStoredOccurrenceBytes += occurrenceBytes;
          }
          if (requested) {
            currentPaths.set(entry.path, { path: entry.path, occurrences });
          }
        }
      }
      for (const path of requestedPaths) {
        if (!entryPaths.has(path)) {
          currentPaths.set(path, { path, occurrences: [] });
        }
      }
      return {
        authoritativeOid,
        currentPaths,
        unavailableOriginalPaths,
        repositoryCounts: repositoryComplete ? repositoryCounts : null,
        coverageReasons,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async readBlobs(
    workspace: string,
    bare: string,
    env: NodeJS.ProcessEnv,
    baseArgs: string[],
    entries: TreeEntry[],
    signal: AbortSignal | undefined,
  ): Promise<Map<string, Buffer>> {
    const unique = new Map<string, number>();
    for (const entry of entries) unique.set(entry.oid, entry.size);
    if (unique.size === 0) return new Map();

    const expected = [...unique].map(([oid, size]) => ({ oid, size }));
    const stdin = Buffer.from(
      `${expected.map((entry) => entry.oid).join("\n")}\n`,
      "ascii",
    );
    const stdoutBytes =
      expected.reduce((total, entry) => total + entry.size, 0) +
      expected.length * 96;
    const result = await this.git(
      workspace,
      env,
      [...baseArgs, `--git-dir=${bare}`, "cat-file", "--batch"],
      signal,
      workspace,
      stdoutBytes,
      stdin,
    );
    return parseBatchBlobs(result.stdout, expected);
  }

  private async git(
    cwd: string,
    env: NodeJS.ProcessEnv,
    args: string[],
    signal: AbortSignal | undefined,
    workspace: string,
    stdoutBytes = LIMITS.gitStdoutBytes,
    stdin?: Buffer,
  ): Promise<{ stdout: Buffer; stderr: Buffer }> {
    this.processCount += 1;
    if (this.processCount > LIMITS.gitProcesses) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git 프로세스 수 한도를 초과했습니다",
      );
    }
    const started = performance.now();
    let result: { stdout: Buffer; stderr: Buffer } | undefined;
    let failure: unknown;
    const invocation = gitInvocation(args);
    try {
      result = await spawnBounded(invocation.executable, invocation.args, {
        cwd,
        env,
        limits: {
          timeoutMs: LIMITS.gitCommandMs,
          stdoutBytes,
          stderrBytes: LIMITS.gitStderrBytes,
          monitor: async () =>
            (await directorySize(workspace)) >= this.thresholdBytes,
          monitorMs: LIMITS.gitMonitorMs,
          ...(signal ? { signal } : {}),
        },
        ...(stdin ? { stdin } : {}),
      });
    } catch (error) {
      failure = error;
    }
    this.totalGitMs += performance.now() - started;
    if (this.totalGitMs > LIMITS.gitTotalMs) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "누적 Git 실행 시간 한도를 초과했습니다",
      );
    }
    if (failure !== undefined) throw failure;
    if (!result)
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git 실행 결과를 확인할 수 없습니다",
      );
    return result;
  }

  private async preflight(): Promise<void> {
    const usage = await statfs(this.root);
    const free = usage.bavail * usage.bsize;
    const configuredHeadroom = this.thresholdBytes + 64 * 1024 * 1024;
    if (free < configuredHeadroom) {
      throw new AppError(
        "WORKSPACE_LIMIT",
        "Git 작업을 위한 디스크 여유 공간이 부족합니다",
      );
    }
  }
}
function gitInvocation(args: string[]): {
  executable: string;
  args: string[];
} {
  if (process.platform !== "linux") return { executable: "git", args };
  return {
    executable: "prlimit",
    args: [
      `--as=${LIMITS.gitAddressSpaceBytes}`,
      `--cpu=${LIMITS.gitCpuSeconds}`,
      `--fsize=${LIMITS.gitFileBytes}`,
      `--nofile=${LIMITS.gitOpenFiles}`,
      "--",
      "git",
      ...args,
    ],
  };
}
function partitionBlobEntries(entries: TreeEntry[]): TreeEntry[][] {
  const oidSizes = new Map<string, number>();
  const batches: TreeEntry[][] = [];
  let batch: TreeEntry[] = [];
  let batchOids = new Set<string>();
  let batchBytes = 0;

  for (const entry of entries) {
    const knownSize = oidSizes.get(entry.oid);
    if (knownSize !== undefined && knownSize !== entry.size) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git blob 크기가 일관되지 않습니다",
      );
    }
    oidSizes.set(entry.oid, entry.size);

    const addedBytes = batchOids.has(entry.oid) ? 0 : entry.size;
    if (
      batch.length > 0 &&
      (batch.length >= LIMITS.blobBatchEntries ||
        batchBytes + addedBytes > LIMITS.blobBatchBytes)
    ) {
      batches.push(batch);
      batch = [];
      batchOids = new Set();
      batchBytes = 0;
    }
    batch.push(entry);
    if (!batchOids.has(entry.oid)) {
      batchOids.add(entry.oid);
      batchBytes += entry.size;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function validateJobId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "분석 작업 식별자가 안전하지 않습니다",
    );
  }
}

export function jobWorkspacePrefix(jobId: string): string {
  validateJobId(jobId);
  return `job-${jobId}-`;
}

export async function cleanupJobWorkspaces(
  root: string,
  jobId?: string,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const prefix = jobId ? jobWorkspacePrefix(jobId) : "job-";
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

function validateRepositoryName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..") {
    throw new AppError("ANALYSIS_FAILED", "저장소 이름이 안전하지 않습니다");
  }
}

function validateBranch(value: string): void {
  if (
    !value ||
    value.length > 255 ||
    /[\0-\x20~^:?*[\\]/.test(value) ||
    value.includes("..")
  ) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "기본 브랜치 이름이 안전하지 않습니다",
    );
  }
}

export function parseTree(output: Buffer): TreeEntry[] {
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) !== "")
    throw new AppError("ANALYSIS_FAILED", "Git 트리 출력이 잘렸습니다");
  const entries: TreeEntry[] = [];
  for (const record of records.slice(0, -1)) {
    const tab = record.indexOf("\t");
    if (tab < 0)
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git 트리 레코드가 올바르지 않습니다",
      );
    const header = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +(\d+)$/.exec(
      header,
    );
    if (!match) continue;
    if (
      !path ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git 트리 경로가 안전하지 않습니다",
      );
    }
    entries.push({
      mode: match[1]!,
      oid: match[2]!,
      size: Number(match[3]),
      path,
    });
  }
  return entries;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export function parseBatchBlobs(
  output: Buffer,
  expected: ReadonlyArray<{ oid: string; size: number }>,
): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const item of expected) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new AppError("ANALYSIS_FAILED", "Git blob batch 출력이 잘렸습니다");
    }
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== item.oid || Number(match[2]) !== item.size) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "Git blob batch 헤더가 올바르지 않습니다",
      );
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + item.size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new AppError("ANALYSIS_FAILED", "Git blob batch 본문이 잘렸습니다");
    }
    blobs.set(item.oid, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "Git blob batch 출력에 여분 데이터가 있습니다",
    );
  }
  return blobs;
}
