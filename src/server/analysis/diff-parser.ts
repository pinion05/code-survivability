import { AppError } from "../errors";
import { LIMITS } from "../schemas/limits";
import { isEligiblePath, normalizeLine } from "./normalize";

export type ParsedAddition = { path: string; line: string };
export type ParsedDiff = {
  rawAdditions: number;
  changedFiles: number;
  eligibleAdditions: ParsedAddition[];
  representedPaths: string[];
};

type FileState = { destination: string | null; binary: boolean };

function parseDestination(value: string): string | null {
  if (value === "/dev/null") return null;
  if (value.startsWith('"') || value.includes("\t")) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "인용되거나 모호한 diff 경로는 지원하지 않습니다",
    );
  }
  if (!value.startsWith("b/")) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "diff 목적지 경로가 올바르지 않습니다",
    );
  }
  const path = value.slice(2);
  if (!isEligiblePath(path)) return path;
  return path;
}

export function parseAndValidateDiff(
  diff: string,
  metadata: { additions: number; changedFiles: number },
): ParsedDiff {
  if (Buffer.byteLength(diff, "utf8") > LIMITS.diffBytes) {
    throw new AppError(
      "GITHUB_RESPONSE_LIMIT",
      "PR diff 크기 한도를 초과했습니다",
    );
  }
  const lines = diff.split("\n");
  const eligibleAdditions: ParsedAddition[] = [];
  const representedPaths: string[] = [];
  let current: FileState | null = null;
  let rawAdditions = 0;
  let fileCount = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;

  const finishHunk = (): void => {
    if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) {
      throw new AppError("ANALYSIS_FAILED", "잘린 diff hunk를 발견했습니다");
    }
    inHunk = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("diff --git ")) {
      finishHunk();
      fileCount += 1;
      if (fileCount > LIMITS.maxFilesPerPr) {
        throw new AppError(
          "GITHUB_RESPONSE_LIMIT",
          "PR 파일 수 한도를 초과했습니다",
        );
      }
      current = { destination: null, binary: false };
      continue;
    }
    if (!current) {
      if (line === "") continue;
      throw new AppError("ANALYSIS_FAILED", "diff 파일 헤더가 없습니다");
    }
    if (line.startsWith("+++ ")) {
      current.destination = parseDestination(line.slice(4));
      if (current.destination) representedPaths.push(current.destination);
      continue;
    }
    if (
      line.startsWith("GIT binary patch") ||
      line.startsWith("Binary files ")
    ) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("@@ ")) {
      finishHunk();
      if (current.binary || current.destination === undefined) {
        throw new AppError("ANALYSIS_FAILED", "지원하지 않는 diff 구조입니다");
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match)
        throw new AppError(
          "ANALYSIS_FAILED",
          "diff hunk 헤더가 올바르지 않습니다",
        );
      oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
      newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    const marker = line[0];
    if (marker === "+") {
      newRemaining -= 1;
      rawAdditions += 1;
      if (current.destination && isEligiblePath(current.destination)) {
        const normalized = normalizeLine(line.slice(1));
        if (normalized)
          eligibleAdditions.push({
            path: current.destination,
            line: normalized,
          });
      }
    } else if (marker === "-") {
      oldRemaining -= 1;
    } else if (marker === " ") {
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      throw new AppError(
        "ANALYSIS_FAILED",
        "diff hunk 본문이 올바르지 않습니다",
      );
    }
    if (oldRemaining < 0 || newRemaining < 0) {
      throw new AppError(
        "ANALYSIS_FAILED",
        "diff hunk 줄 수가 일치하지 않습니다",
      );
    }
    if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
  }
  finishHunk();
  if (fileCount === 0 && metadata.changedFiles !== 0) {
    throw new AppError("ANALYSIS_FAILED", "빈 diff는 분석할 수 없습니다");
  }
  if (
    rawAdditions !== metadata.additions ||
    fileCount !== metadata.changedFiles
  ) {
    throw new AppError(
      "ANALYSIS_FAILED",
      "GitHub 메타데이터와 diff 원시 집계가 일치하지 않습니다",
    );
  }
  if (rawAdditions > LIMITS.maxRawAdditionsPerPr) {
    throw new AppError(
      "GITHUB_RESPONSE_LIMIT",
      "PR 원시 추가 줄 한도를 초과했습니다",
    );
  }
  if (representedPaths.length > LIMITS.maxPathsPerPr) {
    throw new AppError(
      "GITHUB_RESPONSE_LIMIT",
      "PR 경로 수 한도를 초과했습니다",
    );
  }
  if (eligibleAdditions.length > LIMITS.maxEligibleAdditionsPerPr) {
    throw new AppError(
      "GITHUB_RESPONSE_LIMIT",
      "PR 적격 추가 줄 한도를 초과했습니다",
    );
  }
  return {
    rawAdditions,
    changedFiles: fileCount,
    eligibleAdditions,
    representedPaths,
  };
}
