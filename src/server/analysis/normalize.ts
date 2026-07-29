export function normalizeLine(line: string): string | null {
  const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
  const normalized = withoutCr.trim().replace(/\s+/gu, " ");
  if (Buffer.byteLength(normalized, "utf8") > 1024) return null;
  if ([...normalized].length < 4) return null;
  if (!/[\p{L}\p{N}_]/u.test(normalized)) return null;
  return normalized;
}

const EXCLUDED_PATHS = [
  /(^|\/)node_modules\//i,
  /(^|\/)vendor\//i,
  /(^|\/)dist\//i,
  /(^|\/)generated\//i,
  /(^|\/)(?:package-lock|npm-shrinkwrap)\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /\.min\.(?:js|css)$/i,
  /\.map$/i,
];

export function isEligiblePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".."))
    return false;
  return !EXCLUDED_PATHS.some((pattern) => pattern.test(path));
}
