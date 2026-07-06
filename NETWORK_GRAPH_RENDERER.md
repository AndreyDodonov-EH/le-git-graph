# Network Graph Renderer — Kickoff & Findings

Status: exploratory. This document kick-starts work on a **standalone extension**
that combines the verified cookie-based (no-auth) data source with a proper
git-graph rendering algorithm. It also records the empirically verified findings
from the spike so no one has to re-derive them.

---

## 1. Why a separate extension (not just a PR)

The cookie-based data source is a clean, additive PR against upstream
(`NirmalScaria/le-git-graph`): it feeds the existing renderer and touches no
rendering code. That should still ship as a PR.

Improving the **tree rendering** is a different scope:

- It requires rewriting `assignColors` (in `js/showCommits.js`) and the lane
  layout in `js/drawGraph.js` — the core of upstream.
- Upstream's contribution constraints (see `AGENTS.md`) explicitly say *"the
  renderer is not to be touched"* and *"minimal diff"*. A renderer rewrite
  violates both.

Conclusion: keep two deliverables.

| Deliverable | Scope | Target |
| --- | --- | --- |
| No-auth data source | `js/networkGraphSource.js` + selection/fallback hook | PR to upstream |
| No-auth + new renderer | Full data + rendering pipeline | New standalone extension |

---

## 2. Verified data-source findings (empirical, 2026-07-06)

All verified against the **public** repo `NirmalScaria/le-git-graph` with plain
`curl` (no auth), and in-browser against private/org repos during the spike.
Endpoints are **undocumented** — every consumer must degrade gracefully.

### 2.1 Endpoints

```
GET /{owner}/{repo}/network/meta
GET /{owner}/{repo}/network/chunk?nethash={meta.nethash}&start={n}&end={m}
```

Required headers (same-origin, cookie auth):

```
Accept: application/json
X-Requested-With: XMLHttpRequest
credentials: include
```

Both return `200 application/json` when the session can view the repo. Work
unauthenticated for public repos; ride the session cookie for private/org repos.

### 2.2 `network/meta` shape

```jsonc
{
  "users":    [ { "name": "<owner>", "repo": "<repo>", "heads": [ { "name": "main", "id": "<sha40>" }, ... ] }, ... ],
  "dates":    [ ... ],   // one entry per commit -> length == total commit count
  "blocks":   [ { "name": "<owner>", "start": <int>, "count": <int> }, ... ], // network-graph ROW layout, NOT a commit-array slice
  "focus":    271,        // index of the focused repo's default-branch HEAD commit
  "nethash":  "<hash>",   // REQUIRED for the chunk request
  "spacemap": [ ... ]     // lane/space layout hints
}
```

- `meta.users[0]` is the **focused repo**; the rest are forks in the network.
- `meta.dates.length` == total commit count (275 in the sample).

### 2.3 `network/chunk` shape

```jsonc
{
  "commits": [
    {
      "id":       "<sha40>",
      "parents":  [ [ "<parentSha40>", <time>, <space> ], ... ],  // TUPLE: [sha, time, space]
      "message":  "…",        // full message; first line == headline
      "author":   "Display Name",
      "login":    "githubLogin",
      "date":     "2025-10-31 21:09:46",   // may also be epoch in `time`
      "gravatar": "https://avatars.githubusercontent.com/u/…",
      "space":    <int>,       // precomputed lane index
      "time":     <int>        // 0-based position in this repo's ordering
    },
    ...
  ]
}
```

### 2.4 Indexing & pagination (verified)

- The chunk array is **oldest-first**: index `0` is the very first commit.
- To get the newest window: `start = total - windowSize`, `end = total`, where
  `total = meta.dates.length`.
- "Load more" = fetch the previous window `[loadedStart - windowSize, loadedStart)`.

### 2.5 Fork-network filtering (verified, important)

`network/meta` + `network/chunk` return the **entire fork network**, not just
the focused repo. Probes that FAILED to narrow it server-side:

- `?focus=271` on both `meta` and `chunk` — **ignored**, fork commits still returned.
- `meta.blocks` — is the **row layout**, does NOT index the commit array
  (block says `NirmalScaria [0..5]`, real commits span `[0..44]`, `[48..50]`, …).
- Commits from different forks are **interleaved** in the array (50+ owner runs),
  so no contiguous slice isolates one repo.

Author/owner filtering is **wrong**: e.g. commit `7f2b54c` was authored by a
fork contributor (`Easymean1207`) but is part of `main` via merged PR #108.
Filtering by author would drop legitimately-merged commits.

**Correct approach:** graph **reachability** from the focused repo's heads
(`meta.users[0].heads`), walking parent links. This mirrors exactly what the
original extension's `refs/heads/` GraphQL query returns. Implemented as
`extractFocusedRepoHeads` + `filterReachableFromHeads` in
`js/networkGraphSource.js`.

Server-filtered alternative (not used): the `/{owner}/{repo}/commits/{branch}`
HTML partial returns only one repo's commits, but is per-branch (N requests +
merge), returns HTML not JSON, and loses precomputed `space`/lane values.

### 2.6 Per-commit stats (verified)

`network/chunk` does NOT carry additions/deletions or CI status. These are
lazy-loaded, on hover, cached per sha, from the same-origin commit page:

```
GET /{owner}/{repo}/commit/{sha}   ->  parse "N additions & M deletions"
```

---

## 3. Current renderer analysis & limitations

Files: `js/showCommits.js` (`assignColors`) and `js/drawGraph.js` (`drawGraph`).

What it does today:

- `assignColors` assigns a `lineIndex` + `color` per commit, propagating the
  color/lane to the **first parent only**.
- `drawGraph` builds a 2D `indexArray` (row × lanes) with nested loops that scan
  all commits per lane — roughly O(lanes × commits²).

Limitations:

- **Merges are mishandled**: a merge's second+ parents get a *random* color and
  no proper lane; octopus merges (>2 parents) are not modeled.
- **No lane reservation/release**: lanes are not freed when a branch ends, so
  the graph widens unnecessarily and reuses lanes poorly.
- **No crossing minimization**: lines cross more than needed.
- **Recompute-from-scratch** on every page/"load more", O(n²) in commit count.
- We already have `commit.space` (precomputed lane) from the chunk endpoint but
  currently **recompute** lanes instead of using it.

---

## 4. Rendering algorithm direction

Two solid references to borrow from:

1. **`git log --graph` algorithm** — the canonical lane model: maintain a list
   of "active lanes", each holding the sha of the commit it's waiting for. For
   each commit (newest→oldest):
   - Find lanes waiting for this commit's sha (there may be several → they merge
     into this commit).
   - Assign the commit to the leftmost such lane (or a new lane if none).
   - Replace/extend that lane with the commit's **first parent**; allocate new
     lanes for additional parents (merge sources).
   - Free lanes whose waited-for commit has been emitted and has no more
     children.

2. **VS Code Git Graph** (`mhutchie/vscode-git-graph`) — its `Graph`/`branch`
   lane-assignment is a clean, readable implementation of the above with color
   stability and vertex/edge separation. Good structural model to adapt to an
   SVG/DOM renderer.

Two build options:

- **(a) Use the server's precomputed `space`** as the lane index directly. Cheap
  and consistent with GitHub's own network graph. Risk: `space` is laid out for
  GitHub's fork-network view, so after reachability filtering the lanes may be
  sparse/non-contiguous and need compaction.
- **(b) Recompute lanes** from the reachable commit + parent set using the
  `git log --graph` model. More work, but fully under our control and correct
  for the filtered single-repo view. **Recommended** for the standalone
  extension; fall back to (a) if lossless.

Design constraints to keep:

- Incremental: appending older commits on "load more" should extend the graph,
  not recompute from zero.
- Deterministic colors per branch/lane (stable across pages).
- Handle octopus merges (n parents) explicitly.

---

## 5. Concrete next steps

1. Extract the data source into a framework-agnostic module with a documented
   output contract: `{ oid, parents:[{oid}], author, login, date, message,
   space?, isHead, refs:[branchName] }`.
2. Save sanitized `meta` + `chunk` fixtures for `NirmalScaria/le-git-graph` and a
   large repo (e.g. `torvalds/linux`) as test data.
3. Implement lane assignment (option b) as a pure function
   `layout(commits) -> { lanes, edges }`, unit-tested against the fixtures.
4. Build an SVG renderer that consumes `{ lanes, edges }`; separate vertex,
   edge, and hit-target passes (keep the existing hovercard/stats enrichment).
5. Benchmark against a large repo; cap/virtualize rendering for huge histories.
6. Scaffold the standalone extension (own manifest/name/id) reusing the verified
   fetch + reachability filter; keep upstream as a tracked remote for the PR path.

---

## 6. Open questions to resolve

- Is the chunk `end` boundary inclusive or exclusive? (Currently made moot by
  reachability re-filtering on each merge, but worth confirming to simplify.)
- Does `meta.spacemap` encode enough to reconstruct GitHub's lanes losslessly
  for a filtered single-repo view? (Investigate before committing to option a.)
- Behavior on very large repos where GitHub caps/degrades the network graph —
  confirm the shape and cap gracefully.
