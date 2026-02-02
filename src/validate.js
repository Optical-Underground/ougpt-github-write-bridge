export function validatePrRequest(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be JSON object" };

  const repo = input.repo;
  const base = input.base || "main";
  const branch = input.branch;
  const title = input.title;
  const pr_body = input.body || "";
  const edits = input.edits;
  const draft = input.draft || false;

  if (typeof repo !== "string" || !repo.includes("/")) return { ok: false, error: "repo must be 'owner/name'" };
  if (typeof base !== "string" || !base) return { ok: false, error: "base must be non-empty string" };
  if (typeof branch !== "string" || !branch) return { ok: false, error: "branch must be non-empty string" };
  if (typeof title !== "string" || !title) return { ok: false, error: "title must be non-empty string" };
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "edits must be a non-empty array" };

  for (const e of edits) {
    if (!e || typeof e !== "object") return { ok: false, error: "each edit must be an object" };
    if (typeof e.path !== "string" || !e.path) return { ok: false, error: "edit.path required" };
    if (!["create", "update", "delete"].includes(e.action)) return { ok: false, error: "edit.action must be create|update|delete" };
    if (e.action !== "delete") {
      if (typeof e.content !== "string") return { ok: false, error: "edit.content must be string for create/update" };
    }
  }

  return {
    ok: true,
    data: { repo, base, branch, title, pr_body, edits, draft }
  };
}
