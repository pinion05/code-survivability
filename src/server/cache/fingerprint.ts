import { createHash } from "node:crypto";
import {
  ALGORITHM_VERSION,
  LIMITS,
  SELECTION_VERSION,
} from "../schemas/limits";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function analysisFingerprint(canonicalLogin: string): string {
  return createHash("sha256")
    .update(
      `${canonicalLogin}\n${ALGORITHM_VERSION}\n${SELECTION_VERSION}\n${canonicalJson(LIMITS)}`,
    )
    .digest("hex");
}

export { canonicalJson };
