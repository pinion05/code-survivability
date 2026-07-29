import { createHash, randomBytes } from "node:crypto";

const salt = randomBytes(32);

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const source =
    forwarded?.split(",").at(-1)?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return createHash("sha256")
    .update(salt)
    .update(source.slice(0, 128))
    .digest("hex")
    .slice(0, 24);
}
