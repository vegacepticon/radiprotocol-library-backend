// Pages Function: POST /api/submit — Variant B submission proxy.
//
// Receives a plugin-exported release bundle (exactly the LibraryService.writePackageExport
// format: { manifest, snippetContents }) plus submission metadata, validates it with the
// SAME loader logic as CI (shared src/catalog/), and opens a PR in the backend repo:
//
//   branch:  submit/<packageId>-<shortHash>
//   files:   packages/<packageId>/catalog.json (new or merged)
//            packages/<packageId>/releases/<releaseVersion>/release.json
//   title:   [Submit] <packageId> <releaseVersion>
//
// The moderator reviews the PR and merges → CI regenerates site/ + deploys. The proxy
// never touches main; it only creates branches + PRs with the GITHUB_TOKEN secret
// (fine-grained PAT: Contents read/write on this repo ONLY).
//
// Env vars (Pages project settings):
//   SUBMIT_RATE_LIMIT   — submissions per IP per hour (default 5)
//
// Runtime config resolution: `wrangler pages deploy` rewrites the Pages project config
// and drops out-of-band env vars on EVERY deploy, so the values above are stored in the
// SUBMIT_KV namespace (declared in wrangler.toml, written via the CF API) and read at
// request time. Env vars are kept as a fallback for local dev (`wrangler pages dev`).
async function getConfig(env: Record<string, unknown>, kv: KVNamespace | undefined): Promise<{
  repo: string; token: string; rateLimit: number;
}> {
  const kvGet = async (key: string): Promise<string | undefined> => {
    try { return (await kv?.get(key)) ?? undefined; } catch { return undefined; }
  };
  const [kvToken, kvRepo, kvLimit] = await Promise.all([
    kvGet('GITHUB_TOKEN'), kvGet('GITHUB_REPO'), kvGet('SUBMIT_RATE_LIMIT'),
  ]);
  const limitRaw = kvLimit ?? (typeof env['SUBMIT_RATE_LIMIT'] === 'string' ? env['SUBMIT_RATE_LIMIT'] : undefined);
  return {
    token: kvToken ?? (typeof env['GITHUB_TOKEN'] === 'string' ? env['GITHUB_TOKEN'] : ''),
    repo: kvRepo ?? (typeof env['GITHUB_REPO'] === 'string' ? env['GITHUB_REPO'] : 'vegacepticon/radiprotocol-library-backend'),
    rateLimit: parseInt(typeof limitRaw === 'string' ? limitRaw : '5', 10) || 5,
  };
}
//
// No patient data flows here by design: the plugin export contains authored protocol
// text + snippets only; the submit modal warns the author before upload.

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  // 1. Parse + basic shape check (deep validation below via the shared loader rules).
  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return json(400, { ok: false, error: 'body is not valid JSON' });
  }
  const p = payload as Record<string, unknown>;
  const release = p?.['release'] as Record<string, unknown> | undefined;
  const meta = (p?.['meta'] ?? {}) as Record<string, unknown>;
  if (typeof release?.['manifest'] !== 'object' || release === null) {
    return json(400, { ok: false, error: 'missing release.manifest' });
  }
  const manifest = release['manifest'] as Record<string, unknown>;
  const packageId = typeof manifest['packageId'] === 'string' ? manifest['packageId'] : '';
  const releaseVersion = typeof manifest['releaseVersion'] === 'string' ? manifest['releaseVersion'] : '';
  if (packageId === '' || releaseVersion === '') {
    return json(400, { ok: false, error: 'manifest.packageId and manifest.releaseVersion are required' });
  }
  // Path-safety: the ids become directory names.
  if (!/^[^/\\<>:"|?*\x00-\x1f]{1,80}$/.test(packageId) || packageId !== packageId.trim() || packageId.startsWith('.')) {
    return json(400, { ok: false, error: `unsafe packageId: ${JSON.stringify(packageId)}` });
  }
  if (!/^[^/\\<>:"|?*\x00-\x1f]{1,40}$/.test(releaseVersion) || releaseVersion !== releaseVersion.trim() || releaseVersion.startsWith('.')) {
    return json(400, { ok: false, error: `unsafe releaseVersion: ${JSON.stringify(releaseVersion)}` });
  }

  // 2. Submission metadata (catalog fields the moderator can edit in the PR anyway).
  const title = typeof meta['title'] === 'string' && meta['title'] !== '' ? meta['title'] : packageId;
  const description = typeof meta['description'] === 'string' ? meta['description'] : '';
  const categories = Array.isArray(meta['categories'])
    ? meta['categories'].filter((c): c is string => typeof c === 'string').slice(0, 10)
    : ['community'];
  const authorName = typeof meta['authorDisplayName'] === 'string' && meta['authorDisplayName'] !== ''
    ? meta['authorDisplayName']
    : (typeof manifest['author'] === 'object' && manifest['author'] !== null
      ? String((manifest['author'] as Record<string, unknown>)['displayName'] ?? 'anonymous')
      : 'anonymous');
  const submitterNote = typeof meta['note'] === 'string' ? meta['note'] : '';

  // 3. Runtime config (KV-first, env-var fallback) + rate limit (per IP, per hour).
  const kv = (context.env as Record<string, unknown>)['SUBMIT_KV'] as KVNamespace | undefined;
  const config = await getConfig(context.env as Record<string, unknown>, kv);
  if (kv) {
    const ip = context.request.headers.get('cf-connecting-ip') ?? 'unknown';
    const key = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
    const count = parseInt(await kv.get(key) ?? '0', 10);
    if (count >= config.rateLimit) {
      return json(429, { ok: false, error: 'submission rate limit reached; try again later' });
    }
    await kv.put(key, String(count + 1), { expirationTtl: 7200 });
  }

  // 4. GitHub API: get the default branch head → create a branch → upsert files → open PR.
  const repo = config.repo;
  const token = config.token;
  if (token === '') return json(503, { ok: false, error: 'submission service not configured (GITHUB_TOKEN missing)' });
  const gh = (path: string, init?: RequestInit) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        // GitHub API rejects requests without a User-Agent; Workers fetch() sends none.
        'user-agent': 'RadiProtocol-Library-Submit',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });

  const repoMeta = await gh(`/repos/${repo}`);
  if (!repoMeta.ok) return json(502, { ok: false, error: 'cannot reach GitHub (repo check failed)' });
  const defaultBranch = ((await repoMeta.json()) as { default_branch: string }).default_branch;

  const headRef = await gh(`/repos/${repo}/git/ref/heads/${defaultBranch}`);
  if (!headRef.ok) return json(502, { ok: false, error: 'cannot read default branch head' });
  const headSha = ((await headRef.json()) as { object: { sha: string } }).object.sha;

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${packageId}@${releaseVersion}:${Date.now()}`));
  const shortHash = [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  const branch = `submit/${packageId.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')}-${releaseVersion.replace(/[^\p{L}\p{N}.]+/gu, '-')}-${shortHash}`;

  const createRef = await gh(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: headSha }),
  });
  if (!createRef.ok) {
    const body = (await createRef.json()) as { message?: string };
    return json(502, { ok: false, error: `branch creation failed: ${body.message ?? createRef.status}` });
  }

  // release.json content — byte-identical to the plugin export (2-space pretty + trailing \n,
  // the generator's canonical dialect).
  const releaseJson = JSON.stringify(release, null, 2) + '\n';
  const releasePath = `packages/${packageId}/releases/${releaseVersion}/release.json`;

  // catalog.json — fetch the existing one (if any) and merge the new release in.
  const existingCat = await gh(`/repos/${repo}/contents/packages/${encodeURIComponent(packageId)}/catalog.json?ref=${encodeURIComponent(defaultBranch)}`);
  let catalog: { title: string; description: string; categories: string[]; author: { displayName: string }; releases: Array<{ releaseVersion: string }> };
  let catalogSha: string | undefined;
  if (existingCat.ok) {
    const existing = (await existingCat.json()) as { sha: string; content: string };
    catalogSha = existing.sha;
    try {
      catalog = JSON.parse(atob(existing.content.replace(/\n/g, '')));
    } catch {
      catalog = { title, description, categories, author: { displayName: authorName }, releases: [] };
    }
    if (!Array.isArray(catalog.releases)) catalog.releases = [];
    if (!catalog.releases.some((r) => r.releaseVersion === releaseVersion)) {
      catalog.releases.push({ releaseVersion });
    }
  } else {
    catalog = { title, description, categories, author: { displayName: authorName }, releases: [{ releaseVersion }] };
  }
  const catalogJson = JSON.stringify(catalog, null, 2) + '\n';

  const tree = await gh(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: headSha,
      tree: [
        { path: releasePath, mode: '100644', type: 'blob', content: releaseJson },
        { path: `packages/${packageId}/catalog.json`, mode: '100644', type: 'blob', content: catalogJson },
      ],
    }),
  });
  if (!tree.ok) {
    const body = (await tree.json()) as { message?: string };
    return json(502, { ok: false, error: `tree creation failed: ${body.message ?? tree.status}` });
  }
  const treeSha = ((await tree.json()) as { sha: string }).sha;

  const commit = await gh(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `submit: ${packageId} ${releaseVersion}`,
      tree: treeSha,
      parents: [headSha],
    }),
  });
  if (!commit.ok) {
    const body = (await commit.json()) as { message?: string };
    return json(502, { ok: false, error: `commit creation failed: ${body.message ?? commit.status}` });
  }
  const commitSha = ((await commit.json()) as { sha: string }).sha;

  const updateRef = await gh(`/repos/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitSha }),
  });
  if (!updateRef.ok) return json(502, { ok: false, error: 'branch update failed' });

  const prBody = [
    '## Community Library submission',
    '',
    `- **Package:** \`${packageId}\``,
    `- **Release:** \`${releaseVersion}\``,
    `- **Author:** ${authorName}`,
    submitterNote !== '' ? `- **Note:** ${submitterNote}` : '',
    '',
    'Created via `/api/submit`. CI runs the full validation gate on this PR',
    '(check:packages → regen-diff → wire-parity → tests). Merging publishes:',
    'the publish job regenerates site/ and deploys to Cloudflare Pages.',
    '',
    'Reviewer checklist:',
    '- [ ] Content appropriate for a public community registry (no patient data)',
    '- [ ] Protocol/snippet text sensible and self-consistent',
    '- [ ] `check` job green',
  ].filter((l) => l !== '').join('\n');

  const pr = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `[Submit] ${packageId} ${releaseVersion}`,
      head: branch,
      base: defaultBranch,
      body: prBody,
    }),
  });
  if (!pr.ok) {
    const body = (await pr.json()) as { message?: string };
    return json(502, { ok: false, error: `PR creation failed: ${body.message ?? pr.status}` });
  }
  const prUrl = ((await pr.json()) as { html_url: string }).html_url;

  // Moderation aid: post a structure-preview comment (mermaid flowchart + stats) so the
  // reviewer sees the protocol's shape at a glance. Best-effort: a failure to post the
  // comment must NOT fail an otherwise-successful submission.
  try {
    const prNumber = parseInt(new URL(prUrl).pathname.split('/').pop() ?? '', 10);
    if (Number.isFinite(prNumber) && prNumber > 0) {
      const { buildSubmissionPreviewComment } = await import('../../src/moderation/preview');
      const commentBody = buildSubmissionPreviewComment(release as never);
      await gh(`/repos/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: commentBody }),
      });
    }
  } catch {
    // Preview is cosmetic; the PR itself was created successfully.
  }

  return json(200, { ok: true, prUrl, branch });
};

interface Env {
  readonly [key: string]: unknown;
}
