#!/usr/bin/env node
// Fetches every CPAO issue completed in the rolling window (default 90 days)
// from the Jira REST API, writing:
//   data/cpao-win-1.jsonl — one light issue record per line (build.js input)
//   data/meta.json        — window dates, JQL, project totals (injected by build.js)
// Auth: see lib.js (env vars in CI, .atlassian-token locally).
const fs = require("fs");
const path = require("path");
const { jiraFetch } = require("./lib");

const PROJECT = "CPAO";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS) || 90;
const dataDir = path.join(__dirname, "data");

// Window start as a calendar date in the Jira account's timezone (Europe/London);
// JQL date literals are interpreted in that timezone.
const startDate = new Date(Date.now() - WINDOW_DAYS * 86400000);
const windowStart = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(startDate);
const jql = `project = ${PROJECT} AND statusCategory = Done AND resolved >= "${windowStart}" ORDER BY resolved ASC`;

const FIELDS = "summary,issuetype,assignee,created,resolutiondate,status,resolution";
const iso = t => (t ? new Date(t).toISOString() : null);

async function searchAll() {
  const records = [];
  let pageToken = null;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: FIELDS });
    if (pageToken) qs.set("nextPageToken", pageToken);
    const j = await jiraFetch("/rest/api/3/search/jql?" + qs);
    for (const it of j.issues || []) {
      const f = it.fields || {};
      records.push({
        key: it.key,
        summary: f.summary || "",
        type: (f.issuetype && f.issuetype.name) || "Unknown",
        assigneeId: (f.assignee && f.assignee.accountId) || null,
        assignee: (f.assignee && f.assignee.displayName) || null,
        // Normalise Jira's colon-less "+0100" offsets to ISO UTC — the browser
        // Date parser is only guaranteed to accept the strict ISO form.
        created: iso(f.created),
        resolved: iso(f.resolutiondate),
        status: f.status && f.status.name,
        statusCategory: f.status && f.status.statusCategory && f.status.statusCategory.key,
        resolution: (f.resolution && f.resolution.name) || null,
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) return records;
  }
  throw new Error("pagination did not terminate after 200 pages");
}

async function count(q) {
  const j = await jiraFetch("/rest/api/3/search/approximate-count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jql: q }),
  });
  return j.count;
}

(async () => {
  console.log(`Fetching ${PROJECT} issues completed since ${windowStart} (${WINDOW_DAYS}-day window)…`);
  const [records, all, doneLast12Months] = await Promise.all([
    searchAll(),
    count(`project = ${PROJECT}`),
    count(`project = ${PROJECT} AND statusCategory = Done AND resolved >= -365d`),
  ]);
  if (!records.length) {
    console.error("Fetched 0 issues — refusing to overwrite existing data. Check the JQL and credentials.");
    process.exit(1);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // Clear old window files (earlier snapshots were split across cpao-win-1..N)
  for (const f of fs.readdirSync(dataDir).filter(f => /^cpao-win-\d+\.jsonl$/.test(f))) {
    fs.unlinkSync(path.join(dataDir, f));
  }
  fs.writeFileSync(path.join(dataDir, "cpao-win-1.jsonl"),
    records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const meta = {
    fetchedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    windowStart,
    jql,
    projectTotals: { all, doneLast12Months },
    issueCount: records.length,
  };
  fs.writeFileSync(path.join(dataDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`Done: ${records.length} issues → data/cpao-win-1.jsonl · totals ${all} all-time, ${doneLast12Months} done in 12 months.`);
  console.log("Next: node fetch-changelogs.js");
})().catch(e => { console.error(e.message || e); process.exit(1); });
