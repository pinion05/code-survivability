import type { MetricValue } from "../server/schemas/result";

export function MetricCard(props: {
  label: string;
  metric: MetricValue;
  note: string;
}) {
  const formatted = () =>
    props.metric.percent === null
      ? "확인 불가"
      : `${props.metric.percent.toFixed(1)}%`;
  return (
    <article class="panel metric-card">
      <div class="metric-label">{props.label}</div>
      <div
        class={`metric-value ${props.metric.available ? "" : "unavailable"}`}
      >
        {formatted()}
      </div>
      <div class="metric-count">
        {props.metric.available
          ? `${props.metric.numerator.toLocaleString()} / ${props.metric.denominator.toLocaleString()}줄`
          : props.note}
      </div>
    </article>
  );
}
