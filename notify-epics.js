#!/usr/bin/env node
// Daily "no epic" digest to Google Chat: every CPAO ticket that is being
// worked on, in an open sprint or in an in-progress status, but has no parent
// epic. Grouped by assignee with an @mention, oldest first. The wider backlog
// is summarised as one count line rather than listed: dozens of To Do tickets
// without an epic is a grooming job, not a morning alert. Posts nothing when
// nothing active is missing an epic. Runs from the scheduled workflow.
//
// Webhook, mention map and DRY_RUN=1 are handled by chat.js (shared with
// notify.js).
const { SITE, searchIssues, countIssues, DIGEST_FIELDS, toTicket } = require("./lib");
const { clean, trunc, userMap, target, groupByAssignee, buildDigest, deliver } = require("./chat");

const PROJECT = "CPAO";
// Sub-tasks always have a parent, so "parent IS EMPTY" keeps them out too:
// their epic comes via the story, which is flagged in its own right.
const NO_EPIC = `project = ${PROJECT} AND issuetype != Epic AND parent IS EMPTY AND statusCategory != Done`;
const ACTIVE = `${NO_EPIC} AND (sprint in openSprints() OR statusCategory = "In Progress")`;

(async () => {
  const dest = target();
  if (!dest) return;

  const [active, total] = await Promise.all([
    searchIssues(ACTIVE + " ORDER BY created ASC", DIGEST_FIELDS).then(r => r.map(toTicket)),
    countIssues(NO_EPIC),
  ]);
  const backlog = Math.max(total - active.length, 0);
  console.log(active.length + " active tickets without an epic; " + backlog + " more in the backlog.");
  if (!active.length) {
    console.log("Nothing active is missing an epic, nothing to post.");
    return;
  }

  // oldest ticket first within and across assignees
  const groups = groupByAssignee(active, t => -new Date(t.created).getTime());
  const today = new Date().toISOString().slice(0, 10);
  const fmtTicket = t => "• <" + SITE + "/browse/" + t.key + "|" + t.key + "> "
    + trunc(clean(t.summary), 60) + " (" + clean(t.status) + ", created " + String(t.created).slice(0, 10) + ")";
  const { text, shown } = buildDigest({
    intro: [
      "*Tickets without an epic · " + today + "*",
      active.length + (active.length === 1 ? " active ticket has" : " active tickets have")
        + " no parent epic. Please link " + (active.length === 1 ? "it" : "them") + " to one:",
    ],
    groups,
    users: userMap(),
    fmtTicket,
    footer: backlog ? ["_Plus " + backlog + " in the backlog (not in an open sprint) with no epic._"] : [],
  });
  if (!(await deliver(dest, text))) return;
  // counts only: this repo's CI logs are public
  console.log("Posted: " + shown + " of " + active.length + " tickets across " + groups.length + " assignees.");
})().catch(e => { console.error(e.message || e); process.exit(1); });
