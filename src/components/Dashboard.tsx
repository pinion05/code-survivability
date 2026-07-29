import { For, Show, createSignal } from "solid-js";
import type { AnalysisResult, MetricValue } from "../server/schemas/result";
import { MetricCard } from "./MetricCard";

const smallMetric = (metric: MetricValue): string =>
  metric.available && metric.percent !== null
    ? `${metric.percent.toFixed(1)}%`
    : "확인 불가";

export default function Dashboard(props: {
  result: AnalysisResult;
  shareMode?: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  const result = () => props.result;

  async function copyShare() {
    await navigator.clipboard.writeText(
      `${window.location.origin}/r/${result().id}`,
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div class="shell">
      <div class="result-header">
        <div class="result-title">
          <span class="eyebrow">분석 완료</span>
          <h1>@{result().canonicalLogin}의 코드 생존 기록</h1>
          <p>
            {new Date(result().authoritativeWindow.start).toLocaleDateString(
              "ko-KR",
            )}
            부터{" "}
            {new Date(result().authoritativeWindow.end).toLocaleDateString(
              "ko-KR",
            )}
            까지의 공개 PR
          </p>
        </div>
        <button class="share-button" type="button" onClick={copyShare}>
          {copied() ? "링크 복사됨" : "결과 링크 복사"}
        </button>
      </div>

      <section aria-labelledby="metric-title">
        <h2 class="sr-only" id="metric-title">
          생존 지표
        </h2>
        <div class="metrics-grid">
          <MetricCard
            label="원래 경로의 정확한 발생"
            metric={result().summary.originalPath}
            note="경로 검사가 불완전합니다"
          />
          <MetricCard
            label="저장소 전체 텍스트 발생"
            metric={result().summary.repositoryText}
            note="전체 트리 검사가 불완전합니다"
          />
          <MetricCard
            label="Blame 평가 범위"
            metric={result().summary.blameEvaluated}
            note="완전한 blame을 얻지 못했습니다"
          />
          <MetricCard
            label="PR 커밋 계보"
            metric={result().summary.lineage}
            note="계보를 완전히 확인하지 못했습니다"
          />
        </div>
        <div class="summary-line">
          <span>
            적격 추가 줄{" "}
            <strong>
              {result().summary.eligibleAdditions.toLocaleString()}
            </strong>
          </span>
          <span>
            분석 PR <strong>{result().summary.analyzedPullRequests}</strong>
          </span>
          <span>
            제외 PR <strong>{result().summary.excludedPullRequests}</strong>
          </span>
          <span>
            알고리즘 <strong>{result().algorithmVersion}</strong>
          </span>
        </div>
      </section>

      <section class="panel coverage-panel" aria-labelledby="coverage-title">
        <div class="panel-title">
          <h2 id="coverage-title">발견 범위와 신뢰도</h2>
          <span
            class={`status-pill ${result().discovery.complete ? "good" : "warn"}`}
          >
            {result().discovery.complete
              ? "발견 범위 완전"
              : "제한된 발견 범위"}
          </span>
        </div>
        <div class="coverage-grid">
          <div class="coverage-stat">
            <span>GitHub 보고 결과</span>
            <strong>
              {result().discovery.queryTotalCount ?? "알 수 없음"}
            </strong>
          </div>
          <div class="coverage-stat">
            <span>반환 / 선택</span>
            <strong>
              {result().discovery.returnedCount} /{" "}
              {result().discovery.selectedCount}
            </strong>
          </div>
          <div class="coverage-stat">
            <span>수화된 PR</span>
            <strong>{result().discovery.hydratedCount}</strong>
          </div>
          <div class="coverage-stat">
            <span>저장소</span>
            <strong>{result().repositories.length}</strong>
          </div>
        </div>
        <Show when={result().discovery.reasons.length > 0}>
          <ul class="warning-list">
            <For each={result().discovery.reasons}>
              {(item) => (
                <li>
                  {item.message} <small>({item.code})</small>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="panel coverage-panel" aria-labelledby="caveat-title">
        <div class="panel-title">
          <h2 id="caveat-title">해석할 때 알아둘 점</h2>
        </div>
        <ul class="caveats">
          <For each={result().caveats}>{(caveat) => <li>{caveat}</li>}</For>
        </ul>
      </section>

      <section class="panel pr-panel" aria-labelledby="pr-title">
        <div class="pr-header">
          <h2 id="pr-title">Pull request별 근거</h2>
          <p>각 비율은 해당 지표에 완전한 증거가 있는 PR만 집계합니다.</p>
        </div>
        <div style={{ "overflow-x": "auto" }}>
          <table class="pr-list">
            <thead>
              <tr>
                <th>Pull request</th>
                <th>원래 경로</th>
                <th>전체 텍스트</th>
                <th>계보</th>
                <th>상세</th>
              </tr>
            </thead>
            <tbody>
              <For each={result().pullRequests}>
                {(pr) => (
                  <tr>
                    <td>
                      <a
                        class="pr-name"
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{pr.number} {pr.title}
                      </a>
                      <div class="pr-repo">
                        {pr.repository} · 적격{" "}
                        {pr.eligibleAdditions.toLocaleString()}줄
                      </div>
                    </td>
                    <td>
                      <span
                        class={`metric-small ${pr.originalPath.available ? "" : "na"}`}
                      >
                        {smallMetric(pr.originalPath)}
                      </span>
                    </td>
                    <td>
                      <span
                        class={`metric-small ${pr.repositoryText.available ? "" : "na"}`}
                      >
                        {smallMetric(pr.repositoryText)}
                      </span>
                    </td>
                    <td>
                      <span
                        class={`metric-small ${pr.lineage.available ? "" : "na"}`}
                      >
                        {smallMetric(pr.lineage)}
                      </span>
                    </td>
                    <td>
                      <details class="pr-detail">
                        <summary>근거 보기</summary>
                        <div class="detail-content">
                          <div>
                            병합:{" "}
                            {new Date(pr.mergedAt).toLocaleDateString("ko-KR")}
                          </div>
                          <div>
                            원래 경로: {pr.originalPath.numerator} /{" "}
                            {pr.originalPath.denominator}
                          </div>
                          <div>
                            텍스트 발생: {pr.repositoryText.numerator} /{" "}
                            {pr.repositoryText.denominator}
                          </div>
                          <div>
                            Blame 평가:{" "}
                            {pr.blameEvaluated.available
                              ? `${pr.blameEvaluated.numerator}줄`
                              : "불가"}
                          </div>
                          <Show when={pr.exclusions.length > 0}>
                            <div>
                              제한:{" "}
                              {pr.exclusions
                                .map((item) => item.code)
                                .join(", ")}
                            </div>
                          </Show>
                        </div>
                      </details>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
