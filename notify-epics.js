#!/usr/bin/env node
// Daily "no epic" digest to Google Chat: every CPAO ticket that has moved past
// the backlog (In Progress, In Review, Reviewed, or Done within the last
// DONE_WINDOW_DAYS) but has no parent epic. Grouped by assignee with an
// @mention, oldest first. The backlog itself is summarised as one count line
// rather than listed: dozens of To Do tickets without an epic is a grooming
// job, not a morning alert, and the 100-plus historical Done ones are a
// clean-up job. Posts nothing when nothing listed is missing an epic. Runs
// from the scheduled workflow.
//
// Webhook, mention map and DRY_RUN=1 are handled by chat.js (shared with
// notify.js).
const { SITE, searchIssues, countIssues, DIGEST_FIELDS, toTicket } = require("./lib");
const { clean, trunc, userMap, target, groupByAssignee, buildDigest, deliver } = require("./chat");

const PROJECT = "CPAO";
// Board statuses that count as being worked on. An unknown name here makes
// Jira reject the query, so a renamed status fails the run loudly.
const WORKING = ["In Progress", "In Review", "Reviewed"];
// How long a Done ticket without an epic keeps being reported after it closes.
const DONE_WINDOW_DAYS = 14;

// Sub-tasks always have a parent, so "parent IS EMPTY" keeps them out too:
// their epic comes via the story, which is flagged in its own right.
const NO_EPIC = `project = ${PROJECT} AND issuetype != Epic AND parent IS EMPTY`;
const LISTED = `${NO_EPIC} AND (status in (${WORKING.map(s => `"${s}"`).join(", ")})`
  + ` OR (statusCategory = Done AND resolved >= -${DONE_WINDOW_DAYS}d))`;
const BACKLOG = `${NO_EPIC} AND statusCategory = "To Do"`; // To Do and In Discussion

(async () => {
  const dest = target();
  if (!dest) return;

  const [listed, backlog] = await Promise.all([
    searchIssues(LISTED + " ORDER BY created ASC", DIGEST_FIELDS).then(r => r.map(toTicket)),
    countIssues(BACKLOG),
  ]);
  console.log(listed.length + " tickets past the backlog without an epic; " + backlog + " more still in it.");
  if (!listed.length) {
    console.log("Nothing past the backlog is missing an epic, nothing to post.");
    return;
  }

  // oldest ticket first within and across assignees
  const groups = groupByAssignee(listed, t => -new Date(t.created).getTime());
  const today = new Date().toISOString().slice(0, 10);
  const fmtTicket = t => "• <" + SITE + "/browse/" + t.key + "|" + t.key + "> "
    + trunc(clean(t.summary), 60) + " (" + clean(t.status) + ", created " + String(t.created).slice(0, 10) + ")";
  const n = listed.length;
  const { text, shown } = buildDigest({
    intro: [
      "*Tickets without an epic · " + today + "*",
      n + (n === 1 ? " ticket" : " tickets") + " in progress, in review, reviewed, or done in the last "
        + DONE_WINDOW_DAYS + " days " + (n === 1 ? "has" : "have") + " no parent epic. Please link "
        + (n === 1 ? "it" : "them") + " to one:",
    ],
    groups,
    users: userMap(),
    fmtTicket,
    footer: backlog ? ["_Plus " + backlog + " still in the backlog with no epic._"] : [],
  });
  if (!(await deliver(dest, text))) return;
  // counts only: this repo's CI logs are public
  console.log("Posted: " + shown + " of " + n + " tickets across " + groups.length + " assignees.");
})().catch(e => { console.error(e.message || e); process.exit(1); });
