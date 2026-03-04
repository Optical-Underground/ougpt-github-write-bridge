function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

async function getRefSha({ octokit, owner, repo, ref }) {
  const r = await octokit.git.getRef({ owner, repo, ref });
  return r.data.object.sha;
}

export async function ensureBranch({ octokit, owner, repo, base, branch }) {
  const baseRef = `heads/${base}`;
  const branchRef = `heads/${branch}`;

  // if branch exists, do nothing
  try {
    await octokit.git.getRef({ owner, repo, ref: branchRef });
    return;
  } catch (e) {
    // continue if not found
    if (e?.status !== 404) throw e;
  }

  const baseSha = await getRefSha({ octokit, owner, repo, ref: baseRef });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/${branchRef}`,
    sha: baseSha
  });
}

async function getContentShaIfExists({ octokit, owner, repo, path, ref }) {
  try {
    const r = await octokit.repos.getContent({ owner, repo, path, ref });
    // If it's a file, it has sha; if dir, this bridge doesn't support
    if (Array.isArray(r.data)) return null;
    return r.data.sha || null;
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
}

export async function applyEdits({ octokit, owner, repo, branch, edits }) {
  for (const e of edits) {
    const path = e.path.replace(/^\/+/, ""); // normalize
    if (e.action === "delete") {
      const sha = await getContentShaIfExists({ octokit, owner, repo, path, ref: branch });
      if (!sha) continue; // already absent
      await octokit.repos.deleteFile({
        owner,
        repo,
        path,
        message: `delete ${path}`,
        sha,
        branch
      });
      continue;
    }

    const sha = await getContentShaIfExists({ octokit, owner, repo, path, ref: branch });

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `${e.action} ${path}`,
      content: b64(e.content),
      branch,
      sha: sha || undefined
    });
  }
}
console.log("openPullRequest head(raw)=", head, "head(normalized)=", normalizedHead, "owner=", owner, "repo=", repo, "base=", base);

export async function openPullRequest({ octokit, owner, repo, base, head, title, body, draft }) {
  const r = await octokit.pulls.create({
    owner,
    repo,
    title,
    head,
    base,
    body,
    draft
  });
  return r.data;
}
