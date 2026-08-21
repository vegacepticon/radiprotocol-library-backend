# Community Library — submission & moderation (Variant B)

The catalog's source of truth is the [`packages/`](packages/) directory in this repo.
Publishing = merging a PR; CI does everything else (validate → regenerate `site/` →
commit → deploy to Cloudflare Pages).

## How a submission arrives

1. A user exports a package from the RadiProtocol plugin (Library → export) and clicks
   **Submit to Community Library**. The plugin POSTs the bundle to `/api/submit`
   (Pages Function on radiprotocol.pages.dev).
2. The proxy validates basic shape/path-safety, rate-limits per IP, then creates:
   - branch `submit/<packageId>-<version>-<hash>`
   - `packages/<packageId>/releases/<version>/release.json` (byte-identical plugin export)
   - `packages/<packageId>/catalog.json` (new, or merged if the package exists)
   - a PR titled `[Submit] <packageId> <version>` with a reviewer checklist.
3. CI runs the full gate on the PR: `check:packages` (catalog validation incl. SHA-256
   integrity of protocol + snippets), regen-diff, wire-parity against the pinned plugin
   rev, tests.

## Moderating a submission

Open the PR. The `check` job must be green — it already proves hashes match and the wire
format is valid. Your review is about **content**, which no gate can judge:

- [ ] No patient data / real case identifiers in the protocol or snippets (public registry!)
- [ ] Clinically sensible text, appropriate for a documentation aid (not diagnostic advice)
- [ ] Title/description/categories reasonable; author credit correct
- [ ] packageId sane (stable slug, matches content)

Then:

- **Approve + merge** → push to main triggers `publish`: regenerates `site/` from
  `packages/`, commits any byte changes as `radiprotocol-bot`, deploys to Cloudflare
  Pages. Live within ~2 minutes.
- **Request changes** → comment on the PR; the submitter (or you) can push fixes to the
  same branch. Note: submitters usually have no GitHub account — expect to apply small
  fixes yourself by pushing to the branch.
- **Close** → spam/reject; optionally delete the branch.

## Manual submissions (no proxy)

Anyone with repo write access can add packages directly: create
`packages/<id>/catalog.json` + `packages/<id>/releases/<ver>/release.json` (a plugin
export file dropped in verbatim), push to a branch, open a PR. Same gate, same flow.

## Local validation before pushing

```bash
npm run check          # typecheck + check:packages + regen-diff + wire-parity + tests
npm run generate       # rebuild site/ locally (CI redoes this on merge)
```

## Updating an existing package

Add a new release directory (`releases/<newVer>/release.json`) and append the version to
`releases` in the package's `catalog.json`. The generator computes `latestVersion` as the
max semver and stamps `updatedAt` from the newest release. Old versions stay downloadable
(the plugin pins exact versions on install).

## Removing a package

Delete its directory under `packages/`. The next publish regenerates `site/` without it.
Already-installed copies in users' vaults are unaffected (they're local files).

## Secrets & configuration

| Where | What |
|---|---|
| GitHub repo secret | `CLOUDFLARE_API_TOKEN` (Pages — Edit) → deploy job |
| GitHub repo variable | `PLUGIN_REPO` (plugin slug for wire-parity checkout) |
| Pages project env vars | `GITHUB_TOKEN` (PAT: Contents read/write on this repo only), `GITHUB_REPO`, optional `SUBMIT_RATE_LIMIT` |
| Pages project binding | optional KV namespace `SUBMIT_KV` (per-IP rate limiting) |

The submit PAT is scoped to THIS repo only and can only create branches/PRs — it cannot
bypass moderation because merges require your approval (branch protection recommended:
require the `check` job + your review on `main`).
