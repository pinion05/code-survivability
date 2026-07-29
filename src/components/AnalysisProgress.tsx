import { Show, createSignal, onCleanup, onMount } from "solid-js";
import type { AnalysisResult } from "../server/schemas/result";
import Dashboard from "./Dashboard";

type Status = {
  state: string;
  phase: string;
  progress: { completedUnits: number; totalUnits: number };
  coverageWarnings: number;
  resultUrl: string | null;
  shareUrl: string | null;
  error: { code: string; message: string } | null;
};

const phases: Record<string, string> = {
  QUEUED: "분석 순서를 기다리고 있습니다",
  STARTING: "안전한 분석 작업을 준비하고 있습니다",
  DIFFS: "PR diff의 완전성을 검증하고 있습니다",
  SCANNING_REPOSITORIES: "현재 저장소와 blame 근거를 확인하고 있습니다",
  COMPLETE: "분석을 완료했습니다",
};

export default function AnalysisProgress(props: { id: string }) {
  const [status, setStatus] = createSignal<Status | null>(null);
  const [result, setResult] = createSignal<AnalysisResult | null>(null);
  const [error, setError] = createSignal("");
  let timer: number | undefined;
  let delay = 1000;
  let lastCompleted = -1;
  const started = Date.now();

  const schedule = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), ms);
  };

  async function poll() {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - started > 15 * 60_000) {
      setError(
        "브라우저 대기 시간이 15분을 초과했습니다. 결과 링크를 다시 열어 주세요.",
      );
      return;
    }
    try {
      const response = await fetch(
        `/api/analyses/${encodeURIComponent(props.id)}/status`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 429 || response.status === 503) {
        const retryAfter =
          Number(response.headers.get("Retry-After") ?? 2) * 1000;
        schedule(retryAfter);
        return;
      }
      const payload = (await response.json()) as Status & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(
          payload.error?.message ?? "분석 상태를 확인하지 못했습니다.",
        );
      setStatus(payload);
      if (payload.progress.completedUnits !== lastCompleted) {
        delay = 1000;
        lastCompleted = payload.progress.completedUnits;
      } else {
        delay = Math.min(8000, delay * 1.6);
      }
      if (payload.state === "SUCCEEDED" && payload.resultUrl) {
        const resultResponse = await fetch(payload.resultUrl);
        if (!resultResponse.ok)
          throw new Error("완료된 결과를 불러오지 못했습니다.");
        setResult((await resultResponse.json()) as AnalysisResult);
        return;
      }
      if (!["RUNNING", "QUEUED"].includes(payload.state)) {
        throw new Error(
          payload.error?.message ?? "분석이 완료되지 않았습니다.",
        );
      }
      schedule(delay * (0.8 + Math.random() * 0.4));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "분석 상태를 확인하지 못했습니다.",
      );
    }
  }

  function visibilityChanged() {
    if (document.visibilityState === "visible" && !result() && !error())
      schedule(0);
    else window.clearTimeout(timer);
  }

  onMount(() => {
    document.addEventListener("visibilitychange", visibilityChanged);
    schedule(0);
  });
  onCleanup(() => {
    if (typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.clearTimeout(timer);
  });

  const percent = () => {
    const progress = status()?.progress;
    if (!progress || progress.totalUnits <= 0) return 4;
    return Math.max(
      4,
      Math.min(96, (progress.completedUnits / progress.totalUnits) * 100),
    );
  };

  return (
    <Show
      when={result()}
      fallback={
        <div class="shell">
          <section
            class={`panel progress-panel ${error() ? "error-panel" : ""}`}
            aria-live="polite"
          >
            <Show
              when={!error()}
              fallback={
                <>
                  <h1 class="progress-title">분석을 완료하지 못했습니다</h1>
                  <p class="progress-copy">{error()}</p>
                  <a
                    class="primary-button"
                    href="/"
                    style={{
                      display: "inline-flex",
                      "align-items": "center",
                      "text-decoration": "none",
                      "margin-top": "18px",
                    }}
                  >
                    다시 분석하기
                  </a>
                </>
              }
            >
              <div class="progress-orbit" aria-hidden="true" />
              <h1 class="progress-title">코드의 현재 흔적을 확인하는 중</h1>
              <p class="progress-copy">
                {phases[status()?.phase ?? "STARTING"] ??
                  "증거를 확인하고 있습니다"}
              </p>
              <div
                class="progress-track"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={Math.round(percent())}
              >
                <div class="progress-fill" style={{ width: `${percent()}%` }} />
              </div>
              <div class="progress-meta">
                <span>
                  {status()?.state === "QUEUED" ? "대기 중" : "분석 중"}
                </span>
                <span>범위 경고 {status()?.coverageWarnings ?? 0}개</span>
              </div>
            </Show>
          </section>
        </div>
      }
    >
      {(loaded) => <Dashboard result={loaded()} />}
    </Show>
  );
}
