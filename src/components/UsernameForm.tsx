import { createSignal } from "solid-js";

export default function UsernameForm() {
  const [username, setUsername] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError("");
    const value = username().trim();
    if (!value) {
      setError("GitHub 사용자명을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: value }),
      });
      const payload = (await response.json()) as {
        jobId?: string;
        error?: { message?: string };
      };
      if (!response.ok || !payload.jobId) {
        throw new Error(
          payload.error?.message ?? "분석 요청을 시작하지 못했습니다.",
        );
      }
      window.location.assign(`/analysis/${encodeURIComponent(payload.jobId)}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "네트워크 요청에 실패했습니다.",
      );
      setBusy(false);
    }
  }

  return (
    <form
      class="username-form"
      onSubmit={submit}
      aria-describedby="username-help form-error"
    >
      <div class="form-box">
        <div class="input-wrap">
          <span class="input-prefix" aria-hidden="true">
            @
          </span>
          <label class="sr-only" for="github-username">
            GitHub 사용자명
          </label>
          <input
            id="github-username"
            class="username-input"
            name="username"
            type="text"
            maxlength={39}
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            placeholder="github-username"
            value={username()}
            onInput={(event) => setUsername(event.currentTarget.value)}
            disabled={busy()}
            required
          />
        </div>
        <button class="primary-button" type="submit" disabled={busy()}>
          {busy() ? "확인 중…" : "생존율 분석"}
        </button>
      </div>
      {error() ? (
        <p class="form-error" id="form-error" role="alert">
          {error()}
        </p>
      ) : (
        <p class="form-help" id="username-help">
          최근 24개월 내 병합된 공개 PR을 최대 30개 분석합니다.
        </p>
      )}
    </form>
  );
}
