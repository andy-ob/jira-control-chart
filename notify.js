#!/usr/bin/env node
// Daily aging-WIP digest to Google Chat: every CPAO issue that has been in
// progress for more than WIP_THRESHOLD_DAYS working days, grouped by assignee
// with an @mention. Runs from the scheduled workflow, independent of the page
// build; posts nothing when no issue is over the threshold.
//
// Webhook, mention map and DRY_RUN=1 are handled by chat.js (shared with
// notify-epics.js).
const { SITE, jiraFetch, changelog, searchIssues, DIGEST_FIELDS, toTicket } = require("./lib");
const { clean, trunc, userMap, target, groupByAssignee, buildDigest, deliver } = require("./chat");

const PROJECT = "CPAO";
const THRESHOLD = Number(process.env.WIP_THRESHOLD_DAYS) || 5; // working days
const DAY = 86400000;

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
  return (await searchIssues(jql, DIGEST_FIELDS)).map(toTicket);
}

(async () => {
  const dest = target();
  if (!dest) return;

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

  // slowest ticket first within and across assignees
  const groups = groupByAssignee(aging, t => t.days);
  const today = new Date().toISOString().slice(0, 10);
  const fmtTicket = t => "• <" + SITE + "/browse/" + t.key + "|" + t.key + "> "
    + trunc(clean(t.summary), 60) + " — *" + t.days.toFixed(1) + " working days* (" + clean(t.status) + ")";
  const { text, shown } = buildDigest({
    intro: [
      "*Aging work in progress · " + today + "*",
      aging.length + (aging.length === 1 ? " ticket has" : " tickets have")
        + " been in progress for more than " + THRESHOLD + " working day" + (THRESHOLD === 1 ? "" : "s") + ":",
    ],
    groups,
    users: userMap(),
    fmtTicket,
  });
  if (!(await deliver(dest, text))) return;
  // counts only: this repo's CI logs are public
  console.log("Posted: " + shown + " of " + aging.length + " tickets across " + groups.length + " assignees.");
})().catch(e => { console.error(e.message || e); process.exit(1); });
