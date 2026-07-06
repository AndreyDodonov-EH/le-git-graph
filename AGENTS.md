# AGENTS.md — le-git-graph: cookie-based data source for private/org repos

## Goal

Add a session-cookie-based data source to le-git-graph (github.com/NirmalScaria/le-git-graph) using GitHub's internal `network/meta` + `network/chunk` endpoints, so private and org-owned repos work without OAuth, PATs, or org app approval. Deliver as a minimal PR against upstream; keep the fork installable if the PR stalls.

## Why this approach

Upstream authenticates via GitHub OAuth. GitHub OAuth has no read-only repo scope, so the app requests full `repo` (read/write), and org-owned private repos are blocked until an org owner approves the OAuth app — which corporate orgs rarely do. Same-origin fetches from a content script ride the user's session cookie: anything visible in the browser is visible to the graph. No token, no scopes, no rate limits.


## Verified spike findings (2026-07-06)

The core access approach has been tested successfully from an MV3 content script injected on `https://github.com/*/*`.

- Content-script logs appear in the GitHub tab's DevTools Console. After changing the script, reload the unpacked extension and then reload the GitHub page.
- A same-origin request to `GET /{owner}/{repo}/network/meta` returned `200` with `application/json` on both a public repository and a private repository visible to the logged-in user. No OAuth token, PAT, or separate authorization was required.
- The meta response currently includes at least `users`, `dates`, `blocks`, `focus`, `spacemap`, and `nethash`.
- `nethash` is required for the chunk request. The verified request shape is `GET /{owner}/{repo}/network/chunk?nethash={meta.nethash}&start={n}&end={m}`.
- The chunk response returned `200` JSON containing `commits`; observed commit fields include `id`, `parents`, `message`, `author`, `login`, `date`, `gravatar`, `space`, and `time`.
- The extension itself is sufficient for verification; pasting the function into the page context is not necessary.
- The current spike reruns only on a full page reload. GitHub performs client-side navigation, so the production integration must detect repository/URL changes, invalidate repo-specific state, and rerun the fetch without depending on reinjection.
- Parsing must remain defensive: inspect status/content type and tolerate empty or malformed bodies before attempting JSON parsing. These endpoints are undocumented.

This validates the feasibility of the cookie-based source. The next step is still Phase 0: inspect upstream and find the smallest integration point before modifying the renderer or auth flow.

## Constraints for PR acceptance

- Minimal diff. Do not restructure upstream code, rename files, reformat, or "improve" unrelated code.
- Match upstream's style exactly (plain JS if that's what it is — no TypeScript, no build step, no new dependencies unless upstream already has a build pipeline).
- New behavior must be additive: existing GraphQL/OAuth path stays the default fallback and must be byte-for-byte unaffected when the new source is unavailable.
- No new manifest permissions if avoidable; `https://github.com/*` host access should already exist for content-script injection — verify before adding anything.

## Phase 0 — Upstream inventory (do first, do not skip)

1. Clone upstream, read the manifest: MV2 vs MV3, content-script entry points, existing host permissions, whether fetches happen in content script or background worker.
2. Locate the data layer: where GraphQL queries are built, where the commit list + parent links are assembled, and the internal commit model shape `{ oid/sha, parents, message, author, date, refs }`.
3. Locate the graph/lane rendering input format — the new source must emit exactly this shape; the renderer is not to be touched.
4. Locate auth handling: token storage, the "authorize" UI, error paths on 401/403. The new source bypasses all of it; note where the fallback decision must hook in.
5. Check open issues/PRs for prior attempts at cookie/session-based fetching — link and reference them in the PR description if they exist.
6. Note the license and CONTRIBUTING.md requirements (CLA, commit style, branch naming).

## Phase 1 — Verify the internal endpoints (manual, devtools)

1. Open any repo's Insights → Network page with devtools open.
2. Capture the exact requests: `GET /{owner}/{repo}/network/meta` and `GET /{owner}/{repo}/network/chunk?nethash={meta.nethash}&start={n}&end={m}`.
3. Record required request headers (`Accept`, `X-Requested-With`, others), status/content type, and the response JSON shape: meta `nethash`, commit rows, parent links, precomputed `space`/lane values, head refs, and date encoding.
4. Repeat on a private org repo you can view (e.g. under `endresshauser-lp`) to confirm the session cookie suffices and the shape is identical. Basic private-repo access is already verified; repeat against the exact target org during integration and sanitize all captured output.
5. Save one meta + one chunk response as test fixtures (sanitized) in the fork; do not commit real private-repo data.

## Phase 2 — Implement the data source

1. New module (e.g. `js/dataSources/networkGraph.js`, adjust to upstream layout) exposing the same interface the GraphQL layer feeds the renderer.
2. Fetch sequence:
   a. `fetch('/{owner}/{repo}/network/meta', {headers, credentials: 'include'})` — same-origin relative URL from the content script; validate the response and read `nethash`, heads, and block layout.
   b. `fetch('/{owner}/{repo}/network/chunk?nethash=' + encodeURIComponent(meta.nethash) + '&start=0&end=N', {headers, credentials: 'include'})` for the visible window; subsequent chunks on "load more".
   c. Map rows to upstream's commit model. Where chunk rows carry lane indices, translate them to upstream's lane representation instead of recomputing; if translation is lossy, fall back to upstream's own lane computation on the mapped commits.
   d. Detect GitHub client-side navigation. When `${owner}/${repo}` changes, cancel or ignore stale requests, clear repo-specific state, and rerun source selection/fetching.
3. Failure handling — every one of these falls through to the existing GraphQL path silently, logging once at `console.debug`:
   a. Non-2xx response (logged-out session, endpoint removed).
   b. JSON parse failure or shape mismatch (guard every field access; validate top-level shape before mapping).
   c. Empty/degenerate data (zero commits on a repo known non-empty).
4. Source selection order: network-graph first always (works logged-in with zero setup), GraphQL second (existing token flow), then upstream's current unauthenticated behavior.
5. No caching beyond what upstream already does; if adding any, key by `${owner}/${repo}/${headSha}` and invalidate on client-side navigation as well as full reload.

## Phase 3 — Tests & verification

1. Unit-test the response mapper against the Phase 1 fixtures (use upstream's test setup if any; if none, keep tests in the fork only and out of the PR unless maintainer wants them).
2. Manual matrix, all through the extension UI: public repo logged out (falls back cleanly), public repo logged in (verified at endpoint level), personal/private repo (verified at endpoint level), org private repo without OAuth approval (the headline integration case), repo with >1 chunk of history (pagination), GitHub client-side navigation between repositories, and logged-out session mid-use (graceful fallback).
3. Confirm zero regression on the GraphQL path by testing with the new module force-disabled.

## Phase 4 — PR

1. One focused PR: the data source module, the selection/fallback hook, README section explaining the new zero-auth path and its caveat.
2. PR description: the org-approval problem (link the existing README section and community discussion https://github.com/orgs/community/discussions/7891), the cookie mechanism, the silent-fallback guarantee, the test matrix results.
3. Explicitly state the risk and mitigation: endpoints are undocumented and may change; failure mode is automatic fallback to current behavior, so worst case equals status quo.
4. If no maintainer response in ~3 weeks, ping once; afterwards maintain the fork with upstream tracked as a remote, rebasing on upstream releases. Do not publish a competing store listing while the PR is open.

## Known risks

- Internal endpoints can change shape on any GitHub deploy — hence hard requirement that every failure path lands in the existing flow.
- GitHub may serve different shapes for very large repos (network graph caps/degrades); test on one large repo (e.g. torvalds/linux) and cap gracefully.
- If upstream is MV2, do not migrate it to MV3 in this PR; work within what exists.
