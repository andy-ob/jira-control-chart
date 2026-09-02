// Shared helpers for the fetch scripts: Jira credential resolution and a fetch
// wrapper that retries rate limits and transient server errors.
//
// Credentials, in order of preference:
//   1. ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN environment variables (CI)
//   2. .atlassian-token in this folder — ONE line, format  email:API_TOKEN  (local)
const fs = require("fs");
const path = require("path");

const SITE = "https://twinkl.atlassian.net";

function credential() {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (email && token) return email + ":" + token;
  const file = path.join(__dirname, ".atlassian-token");
  if (fs.existsSync(file)) {
    const cred = fs.readFileSync(file, "utf8").trim();
    if (cred.includes(":")) return cred;
  }
  console.error("No Jira credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN, or create");
  console.error(".atlassian-token in this folder (one line: email:API_TOKEN). See README.md.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(credential()).toString("base64");
const MAX_ATTEMPTS = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET/POST a Jira REST path and parse the JSON body. Retries 429 (honouring
// Retry-After), 5xx, and network errors with exponential backoff, then throws.
async function jiraFetch(pathname, init = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(SITE + pathname, {
        ...init,
        headers: { Authorization: AUTH, Accept: "application/json", ...(init.headers || {}) },
      });
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      // Release the socket back to the pool before retrying
      try { await res.body?.cancel(); } catch {}
      if (attempt >= MAX_ATTEMPTS) throw new Error("HTTP " + res.status + " after " + attempt + " attempts: " + pathname);
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30000));
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + pathname);
    return res.json();
  }
}

module.exports = { SITE, jiraFetch };
