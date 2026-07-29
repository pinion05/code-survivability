import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/server/errors";
import { parseAndValidateDiff } from "../../src/server/analysis/diff-parser";

const valid = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,4 @@
 const old = true;
+const alpha = 1;
+const alpha = 1;
 return old;
diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;

describe("complete diff validation", () => {
  test("counts raw additions before eligibility and keeps duplicate destination-path lines", () => {
    const parsed = parseAndValidateDiff(valid, {
      additions: 2,
      changedFiles: 2,
    });
    expect(parsed.rawAdditions).toBe(2);
    expect(parsed.changedFiles).toBe(2);
    expect(parsed.eligibleAdditions).toEqual([
      { path: "src/a.ts", line: "const alpha = 1;" },
      { path: "src/a.ts", line: "const alpha = 1;" },
    ]);
  });

  test("rejects truncated hunks", () => {
    const truncated = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,3 @@
 same
+added
`;
    expect(() =>
      parseAndValidateDiff(truncated, { additions: 1, changedFiles: 1 }),
    ).toThrow(AppError);
  });

  test("rejects metadata mismatch before publishing eligible lines", () => {
    expect(() =>
      parseAndValidateDiff(valid, { additions: 3, changedFiles: 2 }),
    ).toThrow("GitHub 메타데이터와 diff 원시 집계가 일치하지 않습니다");
  });

  test("excludes trivial and generated-path additions only after raw counting", () => {
    const diff = `diff --git a/yarn.lock b/yarn.lock
--- a/yarn.lock
+++ b/yarn.lock
@@ -0,0 +1,2 @@
+foo: 1
+{}
`;
    const parsed = parseAndValidateDiff(diff, {
      additions: 2,
      changedFiles: 1,
    });
    expect(parsed.rawAdditions).toBe(2);
    expect(parsed.eligibleAdditions).toHaveLength(0);
  });
});
