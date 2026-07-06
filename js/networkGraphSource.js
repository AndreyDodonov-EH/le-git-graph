// Cookie-based data source using GitHub's internal network graph endpoints.
//
// Same-origin fetches from this content script ride the user's logged-in
// session cookie (credentials: 'include'), so any repository the user can view
// in the browser -- including private and org-owned repos -- works without an
// OAuth token, PAT, or org app approval.
//
// The endpoints are undocumented and may change shape on any GitHub deploy, so
// every failure path returns false and the caller silently falls back to the
// existing GraphQL/OAuth flow. Parsing is defensive throughout.

// Safely read a JSON body: verify status + content type, tolerate empty or
// malformed responses instead of throwing.
async function parseNetworkGraphJson(response) {
  if (!response || !response.ok) return null;
  var contentType = response.headers.get('content-type') || '';
  if (contentType.indexOf('json') === -1) return null;
  var text = await response.text();
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// The chunk endpoint may encode the commit date as an ISO string or an epoch
// number. Return a valid Date, falling back to now if unparseable.
function networkGraphDate(value) {
  if (value == null) return new Date();
  if (typeof value === 'number') {
    var milliseconds = value < 1e12 ? value * 1000 : value;
    var fromNumber = new Date(milliseconds);
    return isNaN(fromNumber.getTime()) ? new Date() : fromNumber;
  }
  var fromString = new Date(value);
  return isNaN(fromString.getTime()) ? new Date() : fromString;
}

// The chunk message is plain text. Escape it and keep only the first line to
// match the messageHeadlineHTML shape the renderer expects.
function networkGraphMessageHtml(message) {
  var firstLine = (message || '').split('\n')[0];
  var container = document.createElement('div');
  container.innerText = firstLine;
  return container.innerHTML;
}

// Build an avatar URL that supports the "&s=40" suffix appended by showCommits.
function networkGraphAvatar(rawCommit) {
  if (rawCommit.login) {
    return 'https://github.com/' + encodeURIComponent(rawCommit.login) + '.png?';
  }
  if (rawCommit.gravatar) {
    return 'https://www.gravatar.com/avatar/' + rawCommit.gravatar + '?';
  }
  return '';
}

// The network graph chunk endpoint does not carry additions/deletions or CI
// status. Those are loaded on demand from the same-origin commit page (which
// rides the session cookie) and cached per sha so each commit is fetched once.
var leGitGraphStatsCache = {};

// Parse the additions/deletions summary out of a commit page's HTML.
// GitHub renders e.g. "2 additions & 2 deletions" in the diffstat header.
function parseNetworkGraphStats(html) {
  var additions = 0;
  var deletions = 0;
  var addMatch = html.match(/([\d,]+)\s+addition/);
  var delMatch = html.match(/([\d,]+)\s+deletion/);
  if (addMatch) additions = parseInt(addMatch[1].replace(/,/g, ''), 10) || 0;
  if (delMatch) deletions = parseInt(delMatch[1].replace(/,/g, ''), 10) || 0;
  return { additions: additions, deletions: deletions };
}

// Populate commit.additions / commit.deletions for a single commit, memoised.
// Best-effort: on any failure the commit keeps its blank values and the caller
// simply renders nothing extra.
async function enrichNetworkGraphCommitStats(commit) {
  if (!commit || !commit.oid || commit.statsLoaded) return;
  if (leGitGraphStatsCache[commit.oid]) {
    Object.assign(commit, leGitGraphStatsCache[commit.oid]);
    return;
  }
  try {
    var splitUrl = window.location.href.split('/');
    var repoOwner = splitUrl[3];
    var repoName = splitUrl[4];
    if (!repoOwner || !repoName) return;
    var response = await fetch(
      '/' + repoOwner + '/' + repoName + '/commit/' + commit.oid,
      { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include', cache: 'no-store' },
    );
    if (!response || !response.ok) return;
    var html = await response.text();
    var stats = parseNetworkGraphStats(html);
    stats.statsLoaded = true;
    leGitGraphStatsCache[commit.oid] = stats;
    Object.assign(commit, stats);
  } catch (error) {
    console.debug('[Le Git Graph] commit stats fetch failed, leaving blank', error);
  }
}

// Map a raw network/chunk payload to the upstream commit model. parents use
// the same { node: { oid } } edge shape the GraphQL path produces so the
// renderer is untouched.
function mapNetworkGraphChunk(chunk) {
  // The network graph encodes each parent as a [sha, time, space] tuple.
  // Older/other shapes may use a bare sha string, a numeric index, or an
  // object -- resolveParentSha tolerates all of them.
  var indexToSha = {};
  chunk.commits.forEach(function (rawCommit, index) {
    if (rawCommit && rawCommit.id) {
      indexToSha[index] = rawCommit.id;
    }
  });

  function resolveParentSha(parent) {
    if (Array.isArray(parent)) {
      // [sha, time, space] -- the sha is the first element.
      if (typeof parent[0] === 'string') return parent[0];
      if (typeof parent[0] === 'number') return indexToSha[parent[0]];
      return undefined;
    }
    if (typeof parent === 'string') return parent;
    if (typeof parent === 'number') return indexToSha[parent];
    if (parent && typeof parent === 'object') {
      return parent.id || parent.oid || (parent.node && parent.node.oid);
    }
    return undefined;
  }

  var commits = [];
  for (var rawCommit of chunk.commits) {
    if (!rawCommit || !rawCommit.id) continue;
    var parents = [];
    if (Array.isArray(rawCommit.parents)) {
      for (var parent of rawCommit.parents) {
        var parentSha = resolveParentSha(parent);
        if (parentSha) parents.push({ node: { oid: parentSha } });
      }
    }
    var avatar = networkGraphAvatar(rawCommit);
    commits.push({
      oid: rawCommit.id,
      messageHeadlineHTML: networkGraphMessageHtml(rawCommit.message),
      committedDate: networkGraphDate(rawCommit.date != null ? rawCommit.date : rawCommit.time),
      parents: parents,
      branches: [],
      author: rawCommit.author || rawCommit.login || '',
      authorLogin: rawCommit.login || rawCommit.author || '',
      authorAvatar: avatar,
      hasUserData: avatar !== '',
      additions: '',
      deletions: '',
      statusCheckRollup: undefined,
    });
  }
  return commits;
}

// Fetch a single [start, end) window of the chunk endpoint and map it.
// Returns an array of commits (possibly empty) or null on failure.
async function fetchNetworkGraphWindow(repoOwner, repoName, nethash, start, end) {
  var params = new URLSearchParams({
    nethash: nethash,
    start: String(start),
    end: String(end),
  });
  var response = await fetch(
    '/' + repoOwner + '/' + repoName + '/network/chunk?' + params.toString(),
    { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include', cache: 'no-store' },
  );
  var chunk = await parseNetworkGraphJson(response);
  if (!chunk || !Array.isArray(chunk.commits)) return null;
  return mapNetworkGraphChunk(chunk);
}

// Pagination state for network graph mode. loadedStart is the lowest chunk
// index already fetched; older commits live below it. Reset on each fresh load.
var leGitGraphNetworkState = null;

// "Load More": fetch the previous (older) window and merge it into allCommits.
// Returns the merged, de-duplicated, newest-first array. If no older commits
// remain, returns the input unchanged.
async function loadOlderNetworkGraphCommits(allCommits) {
  var state = leGitGraphNetworkState;
  if (!state || state.loadedStart <= 0) return allCommits;
  var end = state.loadedStart;
  var start = Math.max(0, end - state.windowSize);
  var older = await fetchNetworkGraphWindow(
    state.repoOwner,
    state.repoName,
    state.nethash,
    start,
    end,
  );
  // Advance the cursor even on failure so a bad window doesn't loop forever.
  state.loadedStart = start;
  if (!older || older.length === 0) return allCommits;

  var byOid = {};
  allCommits.forEach(function (commit) {
    byOid[commit.oid] = commit;
  });
  older.forEach(function (commit) {
    if (!byOid[commit.oid]) {
      byOid[commit.oid] = commit;
      allCommits.push(commit);
    }
  });

  // The older window also contains fork-network commits. Re-apply the focused
  // repo reachability filter so only this repository's history remains.
  if (state.focusedHeadIds && state.focusedHeadIds.length > 0) {
    allCommits = filterReachableFromHeads(allCommits, state.focusedHeadIds);
  }

  allCommits.sort(function (a, b) {
    return b.committedDate - a.committedDate;
  });
  return allCommits;
}

// Identify the heads that belong to the focused repository (the one in the
// URL). meta.users lists every fork in the network as { name, repo, heads };
// only the entry matching the current owner/repo is this repository. Returns
// an array of { name, oid } head descriptors (empty if not resolvable).
function extractFocusedRepoHeads(meta, repoOwner, repoName) {
  if (!meta || !Array.isArray(meta.users)) return [];
  var focusedUser = meta.users.find(function (user) {
    return user && user.name === repoOwner && user.repo === repoName;
  });
  // Fall back to the first user, which the network graph lists as the focus.
  if (!focusedUser) focusedUser = meta.users[0];
  if (!focusedUser || !Array.isArray(focusedUser.heads)) return [];
  var heads = [];
  focusedUser.heads.forEach(function (head) {
    if (!head || !head.name) return;
    var headSha = head.id || head.sha || head.oid;
    if (typeof headSha !== 'string') return;
    heads.push({ name: head.name, oid: headSha });
  });
  return heads;
}

// Keep only the commits reachable from the given head oids by walking parent
// links within the provided set. This excludes fork-network commits that are
// not part of the focused repository's history. Ancestors older than the
// fetched window are simply not reachable yet (they appear once paged in).
function filterReachableFromHeads(commits, headOids) {
  var byOid = {};
  commits.forEach(function (commit) {
    byOid[commit.oid] = commit;
  });
  var reachable = {};
  var stack = [];
  headOids.forEach(function (oid) {
    if (byOid[oid]) stack.push(oid);
  });
  while (stack.length) {
    var oid = stack.pop();
    if (reachable[oid]) continue;
    reachable[oid] = true;
    var commit = byOid[oid];
    if (!commit) continue;
    commit.parents.forEach(function (parent) {
      var parentOid = parent.node.oid;
      if (byOid[parentOid] && !reachable[parentOid]) stack.push(parentOid);
    });
  }
  return commits.filter(function (commit) {
    return reachable[commit.oid];
  });
}

// Fetch and render the commit graph from the network graph endpoints.
// Returns true when the graph was rendered, false to fall back.
async function fetchNetworkGraphCommits() {  window.leGitGraphNetworkMode = false;
  try {
    var splitUrl = window.location.href.split('/');
    var repoOwner = splitUrl[3];
    var repoName = splitUrl[4];
    if (!repoOwner || !repoName) return false;

    var headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    var fetchOptions = { headers: headers, credentials: 'include', cache: 'no-store' };

    var metaResponse = await fetch(
      '/' + repoOwner + '/' + repoName + '/network/meta',
      fetchOptions,
    );
    var meta = await parseNetworkGraphJson(metaResponse);
    if (!meta || typeof meta.nethash !== 'string') {
      console.debug('[Le Git Graph] network/meta unavailable, falling back');
      return false;
    }

    // network/chunk is indexed oldest-first (index 0 is the very first commit),
    // so requesting start=0 returns the oldest history. meta.dates holds one
    // entry per commit, so its length is the total count -- request the newest
    // window at the end of that range.
    var totalCommits = Array.isArray(meta.dates) ? meta.dates.length : 0;
    var windowSize = 100;
    var end = totalCommits > 0 ? totalCommits : windowSize;
    var start = Math.max(0, end - windowSize);

    var chunkResponse = await fetch(
      '/' + repoOwner + '/' + repoName + '/network/chunk?' +
        new URLSearchParams({ nethash: meta.nethash, start: String(start), end: String(end) }).toString(),
      fetchOptions,
    );
    var chunk = await parseNetworkGraphJson(chunkResponse);
    if (!chunk || !Array.isArray(chunk.commits) || chunk.commits.length === 0) {
      console.debug('[Le Git Graph] network/chunk unavailable, falling back');
      return false;
    }

    var commits = mapNetworkGraphChunk(chunk);
    if (commits.length === 0) return false;

    // The network graph returns the entire fork network. Restrict to the
    // focused repository's heads and keep only commits reachable from them,
    // matching what the GraphQL path (this repo's refs/heads) would show.
    var focusedHeads = extractFocusedRepoHeads(meta, repoOwner, repoName);
    var focusedHeadIds = focusedHeads.map(function (head) {
      return head.oid;
    });
    if (focusedHeadIds.length > 0) {
      commits = filterReachableFromHeads(commits, focusedHeadIds);
      if (commits.length === 0) {
        console.debug('[Le Git Graph] no focused-repo commits in window, falling back');
        return false;
      }
    }

    // Record pagination state so "Load More" can fetch older windows.
    leGitGraphNetworkState = {
      repoOwner: repoOwner,
      repoName: repoName,
      nethash: meta.nethash,
      windowSize: windowSize,
      loadedStart: start,
      focusedHeadIds: focusedHeadIds,
    };

    // Newest first, matching the ordering the renderer expects.
    commits.sort(function (a, b) {
      return b.committedDate - a.committedDate;
    });

    var shaSet = {};
    commits.forEach(function (commit) {
      shaSet[commit.oid] = true;
    });

    // Branch heads/names come from the focused repo's heads that are present
    // in the fetched window.
    var heads = [];
    var branchNames = {};
    focusedHeads.forEach(function (head) {
      if (!shaSet[head.oid]) return;
      heads.push({ name: head.name, oid: head.oid });
      branchNames[head.name] = head.oid;
    });

    // Fallback: a commit that is nobody's parent is a branch tip.
    if (heads.length === 0) {
      var parentShaSet = {};
      commits.forEach(function (commit) {
        commit.parents.forEach(function (parent) {
          parentShaSet[parent.node.oid] = true;
        });
      });
      commits.forEach(function (commit) {
        if (!parentShaSet[commit.oid]) {
          var label = commit.oid.substring(0, 7);
          heads.push({ name: label, oid: commit.oid });
          branchNames[label] = commit.oid;
        }
      });
    }

    var headOidSet = {};
    heads.forEach(function (head) {
      headOidSet[head.oid] = true;
    });
    commits.forEach(function (commit) {
      if (headOidSet[commit.oid]) commit.isHead = true;
    });

    var allBranches = {};
    Object.keys(branchNames).forEach(function (name) {
      allBranches[name] = branchNames[name];
    });

    // Signal the pagination path (fetchFurther) to slice locally instead of
    // hitting the token-authenticated GraphQL endpoint.
    window.leGitGraphNetworkMode = true;
    await showCommits(commits.slice(0, 10), branchNames, commits, heads, 1, allBranches);
    showLegend(heads);
    return true;
  } catch (error) {
    console.debug('[Le Git Graph] network graph source failed, falling back', error);
    window.leGitGraphNetworkMode = false;
    return false;
  }
}
