import { z } from "zod";
import { LIMITS } from "./schemas/limits";

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  PUBLIC_ORIGIN: z.url().default("http://localhost:4321"),
  WORKSPACE_ROOT: z.string().min(1).default("/tmp/code-survivability"),
  WORKSPACE_THRESHOLD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(LIMITS.workspaceThresholdBytes),
  BLAME_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type RuntimeConfig = z.infer<typeof schema>;
let cached: RuntimeConfig | null = null;
let validationError: string | null = null;

export function getConfig(): RuntimeConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    validationError = "필수 서버 설정이 유효하지 않습니다";
    throw new Error(validationError);
  }
  cached = parsed.data;
  validationError = null;
  return cached;
}

export function configIsValid(): boolean {
  try {
    getConfig();
    return true;
  } catch {
    return false;
  }
}

export function resetConfigForTests(): void {
  cached = null;
  validationError = null;
}
