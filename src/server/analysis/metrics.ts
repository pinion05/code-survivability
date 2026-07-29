import { AppError } from "../errors";
import type { MetricValue } from "../schemas/result";
import type { ParsedAddition } from "./diff-parser";

export type CurrentOccurrence = { line: string; lineNumber: number };
export type CurrentPath = { path: string; occurrences: CurrentOccurrence[] };
export type BlameRange = { startLine: number; endLine: number; oid: string };
export type CompleteBlame = { oid: string; path: string; ranges: BlameRange[] };

export type EvaluatedMetrics = {
  eligible: number;
  originalPath: MetricValue;
  repositoryText: MetricValue;
  blameEvaluated: MetricValue;
  lineage: MetricValue;
};

const metric = (
  numerator: number,
  denominator: number,
  available = true,
  unavailableReasons: string[] = [],
): MetricValue => ({
  numerator,
  denominator,
  percent:
    available && denominator > 0 ? (numerator / denominator) * 100 : null,
  available,
  unavailableReasons,
});

const increment = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

export function evaluateMetrics(input: {
  additions: ParsedAddition[];
  currentPaths: Map<string, CurrentPath> | null;
  repositoryCounts: Map<string, number> | null;
  blameByPath: Map<string, CompleteBlame | null>;
  authoritativeOid: string;
  lineageOids: ReadonlySet<string>;
}): EvaluatedMetrics {
  const eligible = input.additions.length;
  if (!input.currentPaths) {
    const unavailable = metric(0, eligible, false, [
      "ORIGINAL_PATH_UNAVAILABLE",
    ]);
    return {
      eligible,
      originalPath: unavailable,
      repositoryText: input.repositoryCounts
        ? metric(
            repositoryMatch(input.additions, input.repositoryCounts),
            eligible,
          )
        : metric(0, eligible, false, ["REPOSITORY_SCAN_UNAVAILABLE"]),
      blameEvaluated: metric(0, eligible, false, ["ORIGINAL_PATH_UNAVAILABLE"]),
      lineage: metric(0, eligible, false, ["ORIGINAL_PATH_UNAVAILABLE"]),
    };
  }

  const eligibleByPathLine = new Map<string, Map<string, number>>();
  for (const addition of input.additions) {
    let lines = eligibleByPathLine.get(addition.path);
    if (!lines) {
      lines = new Map();
      eligibleByPathLine.set(addition.path, lines);
    }
    increment(lines, addition.line);
  }

  const selectedByPath = new Map<string, CurrentOccurrence[]>();
  let originalCount = 0;
  for (const [path, expected] of eligibleByPathLine) {
    const physical = input.currentPaths.get(path)?.occurrences ?? [];
    const byLine = new Map<string, CurrentOccurrence[]>();
    for (const occurrence of physical) {
      const list = byLine.get(occurrence.line) ?? [];
      list.push(occurrence);
      byLine.set(occurrence.line, list);
    }
    const selected: CurrentOccurrence[] = [];
    for (const [line, count] of expected) {
      const candidates = (byLine.get(line) ?? []).sort(
        (a, b) => a.lineNumber - b.lineNumber,
      );
      selected.push(...candidates.slice(0, count));
    }
    selected.sort((a, b) => a.lineNumber - b.lineNumber);
    selectedByPath.set(path, selected);
    originalCount += selected.length;
  }

  let blameEvaluated = 0;
  let lineage = 0;
  const blameFailures: string[] = [];
  for (const [path, selected] of selectedByPath) {
    if (selected.length === 0) continue;
    const blame = input.blameByPath.get(path);
    if (!blame || blame.path !== path || blame.oid !== input.authoritativeOid) {
      blameFailures.push(`BLAME_UNAVAILABLE:${path}`);
      continue;
    }
    const ranges = [...blame.ranges].sort((a, b) => a.startLine - b.startLine);
    let complete = true;
    let rangeIndex = 0;
    const selectedOids: string[] = [];
    for (const occurrence of selected) {
      while (
        rangeIndex < ranges.length &&
        ranges[rangeIndex]!.endLine < occurrence.lineNumber
      ) {
        rangeIndex += 1;
      }
      const range = ranges[rangeIndex];
      if (
        !range ||
        range.startLine > occurrence.lineNumber ||
        range.endLine < occurrence.lineNumber
      ) {
        complete = false;
        break;
      }
      selectedOids.push(range.oid);
    }
    if (!complete) {
      blameFailures.push(`BLAME_INCOMPLETE:${path}`);
      continue;
    }
    blameEvaluated += selected.length;
    lineage += selectedOids.filter((oid) => input.lineageOids.has(oid)).length;
  }

  const blameAvailable = blameFailures.length === 0;
  const result: EvaluatedMetrics = {
    eligible,
    originalPath: metric(originalCount, eligible),
    repositoryText: input.repositoryCounts
      ? metric(
          repositoryMatch(input.additions, input.repositoryCounts),
          eligible,
        )
      : metric(0, eligible, false, ["REPOSITORY_SCAN_UNAVAILABLE"]),
    blameEvaluated: blameAvailable
      ? metric(blameEvaluated, eligible)
      : metric(0, eligible, false, blameFailures),
    lineage: blameAvailable
      ? metric(lineage, eligible)
      : metric(0, eligible, false, blameFailures),
  };
  assertMetricInvariants(result);
  return result;
}

function repositoryMatch(
  additions: ParsedAddition[],
  repositoryCounts: Map<string, number>,
): number {
  const expected = new Map<string, number>();
  for (const addition of additions) increment(expected, addition.line);
  let count = 0;
  for (const [line, occurrences] of expected) {
    count += Math.min(occurrences, repositoryCounts.get(line) ?? 0);
  }
  return count;
}

export function assertMetricInvariants(metrics: EvaluatedMetrics): void {
  const { eligible } = metrics;
  const values = [
    metrics.originalPath,
    metrics.repositoryText,
    metrics.blameEvaluated,
    metrics.lineage,
  ];
  if (
    values.some((value) => value.numerator < 0 || value.numerator > eligible)
  ) {
    throw new AppError(
      "INTERNAL_INVARIANT",
      "분석 지표 범위 불변식이 깨졌습니다",
    );
  }
  if (
    metrics.originalPath.available &&
    metrics.repositoryText.available &&
    metrics.originalPath.numerator > metrics.repositoryText.numerator
  ) {
    throw new AppError(
      "INTERNAL_INVARIANT",
      "원래 경로와 저장소 텍스트 지표 불변식이 깨졌습니다",
    );
  }
  if (
    metrics.blameEvaluated.available &&
    (metrics.blameEvaluated.numerator > metrics.originalPath.numerator ||
      metrics.lineage.numerator > metrics.blameEvaluated.numerator)
  ) {
    throw new AppError(
      "INTERNAL_INVARIANT",
      "blame 계보 지표 불변식이 깨졌습니다",
    );
  }
}

export { metric as createMetric };
