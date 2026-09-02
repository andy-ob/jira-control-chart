#!/usr/bin/env node
// Fetches the status-change history for every issue listed in data/cpao-win-*.jsonl
// straight from the Jira REST API (per-issue changelog endpoint, 8 concurrent),
// writing data/cpao-log-1.jsonl for build.js to merge.
// Auth: see lib.js (env vars in CI, .atlassian-token locally).
const fs = require("fs");
const path = require("path");
const { jiraFetch } = require("./lib");

const dataDir = path.join(__dirname, "data");

const keys = [];
for (const f of fs.readdirSync(dataDir).filter(f => /^cpao-win-\d+\.jsonl$/.test(f)).sort()) {
  for (const line of fs.readFileSync(path.join(dataDir, f), "utf8").split("\n")) {
    if (line.trim()) keys.push(JSON.parse(line).key);
  }
}
const uniq = [...new Set(keys)];
if (!uniq.length) {
  console.error("No issues found in data/cpao-win-*.jsonl — run fetch-issues.js first.");
  process.exit(1);
}
console.log("Fetching status history for", uniq.length, "issues…");

async function changelog(key) {
  let startAt = 0;
  const out = [];
  for (;;) {
    const j = await jiraFetch(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`);
    for (const h of j.values || []) {
      for (const it of h.items || []) {
        // ISO-UTC timestamp: browser Date parsing of Jira's "+0100" form is not guaranteed
        if (it.field === "status") out.push([it.fromString, it.toString, new Date(h.created).toISOString()]);
      }
    }
    if (j.isLast !== false || !(j.values || []).length) break;
    startAt += j.values.length;
  }
  return out;
}

(async () => {
  const results = [];
  const failed = [];
  let done = 0;
  const queue = [...uniq];
  async function worker() {
    while (queue.length) {
      const key = queue.shift();
      try {
        results.push({ key, transitions: await changelog(key) });
      } catch (e) {
        failed.push(key + " (" + e.message + ")");
      }
      if (++done % 50 === 0) console.log(done + "/" + uniq.length);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  const withT = results.filter(r => r.transitions.length).length;
  console.log("Done:", results.length, "issues fetched,", withT, "with ≥1 status transition,", failed.length, "failed.");
  if (failed.length) console.log("Failed:", failed.join(", "));
  // A few stragglers are tolerable (the page falls back per issue); a broad
  // failure means the published chart would silently lose its cycle-time basis.
  // Checked before writing, so a bad run never destroys the previous good file.
  if (failed.length > Math.max(3, uniq.length * 0.02)) {
    console.error("Too many changelog fetches failed — aborting without writing so good data isn't replaced.");
    process.exit(1);
  }
  results.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  fs.writeFileSync(path.join(dataDir, "cpao-log-1.jsonl"),
    results.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log("Next: node build.js");
})().catch(e => { console.error(e.message || e); process.exit(1); });
