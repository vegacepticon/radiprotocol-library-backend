# Deploying the Community Library registry

This backend serves the RadiProtocol Community Library catalogue as a **static site** on
Cloudflare Pages (`https://radiprotocol.pages.dev`). All payloads under `site/` are
**committed source-controlled artifacts** generated deterministically from the
`packages/` catalog (the content source of truth — see MODERATION.md) by the generator
(`npm run generate`). The `check:regen-diff` gate in CI enforces that the committed
`site/` always equals generator output, so a deploy is always an upload of committed
bytes — never a build step.

The deploy target is configured in `wrangler.toml` (`name = "radiprotocol"`,
`pages_build_output_dir = "site"`), so `npm run deploy:pages` needs no CLI flags or extra state.

## One-time setup

1. Install dependencies once: `npm install` (also updates `package-lock.json`).
2. Grant **two** Cloudflare options (either is sufficient — use the CI token for automation):
   - **Interactive (manual deploys):** run `wrangler login` and authorize a browser session with
     an account that can manage the `radiprotocol` Pages project (Owner or Pages-edit permission).
   - **CI token (automatic deploys):** create a Cloudflare API Token with the
     **Pages — Edit** permission (account-level). Add it as a repository/org secret named
     `CLOUDFLARE_API_TOKEN` on this GitHub repo.

## Manual redeploy

After editing the `packages/` catalog (see MODERATION.md for the layout):

1. `npm run generate` — rebuilds `site/` deterministically (parse → re-emit preserves key order;
   byte-exact with the trailing-`\n` hash dialect). `npm run check:packages` validates first.
2. Commit the regenerated `site/` bytes (review the diff first; the committed `site/` is the
   deploy source of truth).
3. `npm run deploy:pages` — uploads `site/` to the `radiprotocol` Pages project.

Deploys are byte-deterministic — re-uploading the same committed `site/` produces an identical
origin, so `https://radiprotocol.pages.dev/catalog` (application/json) does not change unless
the `packages/` catalog actually changed.

## Automatic deploy (CI)

A push to `main` runs `.github/workflows/ci.yml`: the `check` job (typecheck → check:packages →
regen-diff → wire-parity at the pinned plugin rev → test) must pass, then the `publish` job
regenerates `site/` from `packages/`, commits any changed bytes as `radiprotocol-bot`, pushes,
and uploads `site/` via `npm run deploy:pages` with `CLOUDFLARE_API_TOKEN`. PR branches only run
`check` (the `publish` job is guarded to `github.ref == 'refs/heads/main'`).

> **Activation condition:** the deploy step of `publish` fails red on `main` until
> `CLOUDFLARE_API_TOKEN` is configured as a repo/org secret. This is accepted and documented by
> design — configure the secret to turn the automatic deploy on.

## Rollback

Revert to a previous origin by deploying the prior committed `site/`:

1. `git checkout <commit-with-desired-site/>` (or `git revert` / cherry-pick the offending seed +
   generate commit).
2. `npm run deploy:pages` — re-uploads the prior committed `site/`.

Because every deploy is an upload of committed bytes, "rollback" is simply "check out the old
`site/` and redeploy"; no database or storage migration is involved.
