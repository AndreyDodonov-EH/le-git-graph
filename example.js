async function fetchAndInspect(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
    ...options,
  });

  const text = await response.text();

  console.log("response", {
    requestedUrl: url,
    finalUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    bodyLength: text.length,
    bodyPreview: text.slice(0, 500),
  });

  if (!text.trim()) {
    return {
      response,
      text,
      json: null,
    };
  }

  try {
    return {
      response,
      text,
      json: JSON.parse(text),
    };
  } catch (error) {
    console.error("JSON parse failed", error);
    return {
      response,
      text,
      json: null,
    };
  }
}


(async () => {
  const [, owner, repo] = location.pathname.split("/");
  if (!owner || !repo) return;

  const headers = {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  const metaResult = await fetchAndInspect(
    `/${owner}/${repo}/network/meta`,
    { headers }
  );

  console.log("meta JSON", metaResult.json);

  const params = new URLSearchParams({
  nethash: metaResult.json.nethash,
  start: "0",
  end: "100",
});

const chunkResult = await fetchAndInspect(
  `/${owner}/${repo}/network/chunk?${params}`,
  { headers }
);

console.log("chunk JSON", chunkResult.json);
})();