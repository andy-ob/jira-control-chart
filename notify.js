#!/usr/bin/env node
// Daily aging-WIP digest to Google Chat: every CPAO issue that has been in
// progress for more than WIP_THRESHOLD_DAYS working days, grouped by assignee
// with an @mention. Runs from the scheduled workflow, independent of the page
// build; posts nothing when no issue is over the threshold.
//
// Webhook: GCHAT_WEBHOOK_URL env var (CI secret) or .gchat-webhook file
// (local, gitignored — one line, the full webhook URL).
// DRY_RUN=1 prints the message instead of posting. Local use only: it prints
// ticket titles and names, and CI logs on this public repo are world-readable.
const fs = require("fs");
const path = require("path");
const { SITE, jiraFetch, changelog } = require("./lib");

const PROJECT = "CPAO";
const THRESHOLD = Number(process.env.WIP_THRESHOLD_DAYS) || 5; // working days
const CHAR_BUDGET = 3800; // Chat truncates text at 4096 chars; keep headroom
const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jira text lands inside Chat markup: strip the characters Chat parses so a
// summary can't inject a mention (<users/all>), break a link, or toggle bold.
const clean = s => String(s || "").replace(/[<>|*_~`]/g, "");

function webhookUrl() {
  if (process.env.GCHAT_WEBHOOK_URL) return process.env.GCHAT_WEBHOOK_URL;
  const f = path.join(__dirname, ".gchat-webhook");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return null;
}

// Working days between two timestamps: whole Saturdays/Sundays removed,
// UTC day boundaries — the same rules the dashboard uses.
function weekendMs(from, to) {
  if (!(to > from)) return 0;
  let total = 0;
  const cur = new Date(from);
  cur.setUTCHours(0, 0, 0, 0);
  while (cur.getTime() < to) {
    const dayStart = cur.getTime();
    const dow = cur.getUTCDay();
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dayEnd = cur.getTime();
    if (dow === 0 || dow === 6) {
      const s = Math.max(dayStart, from), e = Math.min(dayEnd, to);
      if (e > s) total += e - s;
    }
  }
  return total;
}
const workingDays = (from, to) => Math.max(to - from - weekendMs(from, to), 0) / DAY;

// name → status-category key ("new" / "indeterminate" / "done"). Site-wide
// list first (covers statuses renamed since old transitions), then the
// project-scoped list wins where another project reuses a name differently.
async function statusCategories() {
  const map = {};
  for (const s of await jiraFetch("/rest/api/3/status")) {
    map[s.name] = s.statusCategory && s.statusCategory.key;
  }
  for (const t of await jiraFetch("/rest/api/3/project/" + PROJECT + "/statuses")) {
    for (const s of t.statuses || []) {
      if (s.statusCategory && s.statusCategory.key) map[s.name] = s.statusCategory.key;
    }
  }
  return map;
}

async function inProgressIssues() {
  // Epics excluded: they are umbrella containers that sit in progress for
  // months by design and would drown the digest in permanent entries
  const jql = `project = ${PROJECT} AND statusCategory = "In Progress" AND issuetype != Epic ORDER BY created ASC`;
  const out = [];
  let pageToken = null;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ jql, maxResults: "100", fields: "summary,assignee,status,created" });
    if (pageToken) qs.set("nextPageToken", pageToken);
    const j = await jiraFetch("/rest/api/3/search/jql?" + qs);
    for (const it of j.issues || []) {
      const f = it.fields || {};
      out.push({
        key: it.key,
        summary: f.summary || "",
        assignee: (f.assignee && f.assignee.displayName) || null,
        email: (f.assignee && f.assignee.emailAddress) || null,
        status: (f.status && f.status.name) || "",
        created: f.created,
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) return out;
  }
  throw new Error("pagination did not terminate");
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

(async () => {
  const dry = process.env.DRY_RUN === "1";
  if (dry && process.env.CI) {
    console.error("DRY_RUN prints ticket data and CI logs are public — refusing.");
    process.exit(1);
  }
  const url = webhookUrl();
  if (!url && !dry) {
    if (process.env.CI) {
      // a missing secret must not rot into a silently green no-op forever
      console.error("GCHAT_WEBHOOK_URL secret is not set — failing so the gap is visible.");
      process.exit(1);
    }
    console.log("No GCHAT_WEBHOOK_URL configured — skipping notify.");
    return;
  }

  const [catByName, issues] = await Promise.all([statusCategories(), inProgressIssues()]);
  console.log(issues.length + " issues currently in progress; checking ages…");

  // WIP clock: first transition into an in-progress-category status of the
  // CURRENT stretch — a ticket parked back in the backlog (or done and
  // reopened) restarts its clock when picked up again. Created date fallback.
  const aging = [];
  const failed = [];
  const queue = [...issues];
  const now = Date.now();
  async function worker() {
    while (queue.length) {
      const i = queue.shift();
      let trs;
      try {
        trs = await changelog(i.key);
      } catch (e) {
        failed.push(i.key); // skip rather than lose the whole digest
        continue;
      }
      let start = null;
      for (const [, to, at] of trs) {
        const cat = catByName[to];
        if (cat === "indeterminate") { if (start === null) start = new Date(at).getTime(); }
        else if (cat) start = null; // left in-progress: the stretch ended
      }
      if (start === null) start = new Date(i.created).getTime();
      const days = workingDays(start, now);
      if (days > THRESHOLD) aging.push({ ...i, days });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed.length) console.log(failed.length + " changelog fetches failed; their issues were skipped.");
  if (failed.length > Math.max(3, issues.length * 0.2)) {
    console.error("Too many failures — not posting a misleading digest.");
    process.exit(1);
  }

  if (!aging.length) {
    console.log("0 issues over " + THRESHOLD + " working days — nothing to post.");
    return;
  }

  // group by assignee, slowest ticket first within and across groups
  const groups = new Map();
  for (const t of aging) {
    const gk = t.email || t.assignee || "__unassigned";
    if (!groups.has(gk)) groups.set(gk, { email: t.email, name: t.assignee, tickets: [] });
    groups.get(gk).tickets.push(t);
  }
  const ordered = [...groups.values()];
  ordered.forEach(g => g.tickets.sort((a, b) => b.days - a.days));
  ordered.sort((a, b) => b.tickets[0].days - a.tickets[0].days);

  const today = new Date().toISOString().slice(0, 10);
  const fmtTicket = t => "• <" + SITE + "/browse/" + t.key + "|" + t.key + "> "
    + trunc(clean(t.summary), 60) + " — *" + t.days.toFixed(1) + " working days* (" + clean(t.status) + ")";
  const lines = [
    "*Aging work in progress · " + today + "*",
    aging.length + (aging.length === 1 ? " ticket has" : " tickets have")
      + " been in progress for more than " + THRESHOLD + " working day" + (THRESHOLD === 1 ? "" : "s") + ":",
    "",
  ];
  // build within the character budget; a group header is only emitted when at
  // least its first ticket also fits (no dangling @mention)
  let used = lines.join("\n").length;
  let shown = 0;
  const SUFFIX_ROOM = 30; // space held back for the "…and N more." line
  outer: for (const g of ordered) {
    const header = g.email ? "<users/" + g.email + ">" : "*" + clean(g.name || "Unassigned") + "*";
    if (used + header.length + fmtTicket(g.tickets[0]).length + SUFFIX_ROOM > CHAR_BUDGET) break;
    lines.push(header); used += header.length + 1;
    for (const t of g.tickets) {
      const line = fmtTicket(t);
      if (used + line.length + SUFFIX_ROOM > CHAR_BUDGET) { lines.push(""); break outer; }
      lines.push(line); used += line.length + 1;
      shown++;
    }
    lines.push(""); used += 1;
  }
  if (shown < aging.length) lines.push("…and " + (aging.length - shown) + " more.");
  const text = lines.join("\n").trim();

  if (dry) {
    console.log("---- DRY RUN — would post: ----\n" + text);
    return;
  }
  // one transient blip must not lose the day's digest; 4xx fails fast
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error("Chat webhook HTTP " + res.status + " after " + attempt + " attempts");
      await sleep(2000 * attempt); continue;
    }
    break;
  }
  if (!res.ok) throw new Error("Chat webhook HTTP " + res.status);
  // counts only: this repo's CI logs are public
  console.log("Posted: " + shown + " of " + aging.length + " tickets across " + groups.size + " assignees.");
})().catch(e => { console.error(e.message || e); process.exit(1); });
