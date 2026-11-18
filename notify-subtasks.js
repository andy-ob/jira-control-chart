#!/usr/bin/env node
// Daily "sub-tasks in use" digest to Google Chat: every open CPAO sub-task,
// with a reminder that the team does not use that issue type and how to fix
// it. Grouped with an @mention for the assignee, or for whoever created the
// sub-task while it is unassigned, newest first. A sub-task drops off once it
// is converted to another type or closed, so finished ones are never listed:
// there is nothing left to do about them. Posts nothing when there are no
// open sub-tasks. Runs from the scheduled workflow.
//
// Webhook, mention map and DRY_RUN=1 are handled by chat.js (shared with
// notify.js and notify-epics.js).
const { SITE, searchIssues, DIGEST_FIELDS, toTicket } = require("./lib");
const { clean, trunc, userMap, target, groupByAssignee, buildDigest, deliver } = require("./chat");

const PROJECT = "CPAO";
// subTaskIssueTypes() covers every sub-task type, whatever it is named.
const JQL = `project = ${PROJECT} AND issuetype in subTaskIssueTypes() AND statusCategory != Done ORDER BY created DESC`;

// The digest ticket shape plus the parent key, with the creator standing in
// as the person to ping while nobody is assigned.
function toSubTask(it) {
  const f = it.fields || {};
  const t = toTicket(it);
  if (!t.assignee && !t.email && f.creator) {
    t.assignee = f.creator.displayName || null;
    t.email = f.creator.emailAddress || null;
    t.raisedBy = true;
  }
  t.parent = (f.parent && f.parent.key) || null;
  return t;
}

(async () => {
  const dest = target();
  if (!dest) return;

  const subTasks = (await searchIssues(JQL, DIGEST_FIELDS + ",creator,parent")).map(toSubTask);
  if (!subTasks.length) {
    console.log("0 open sub-tasks, nothing to post.");
    return;
  }

  // newest sub-task first within and across people
  const groups = groupByAssignee(subTasks, t => new Date(t.created).getTime());
  const today = new Date().toISOString().slice(0, 10);
  const link = key => "<" + SITE + "/browse/" + key + "|" + key + ">";
  const fmtTicket = t => "• " + link(t.key) + " " + trunc(clean(t.summary), 60)
    + " (" + clean(t.status) + (t.parent ? ", under " + link(t.parent) : "")
    + (t.raisedBy ? ", unassigned, raised by you" : "") + ")";
  const n = subTasks.length;
  const { text, shown } = buildDigest({
    intro: [
      "*Sub-tasks in use · " + today + "*",
      n + (n === 1 ? " open ticket on the " + PROJECT + " board is a sub-task." : " open tickets on the " + PROJECT + " board are sub-tasks.")
        + " We don't use the Sub-task type, so please use a Task or Bug instead:",
    ],
    groups,
    users: userMap(),
    fmtTicket,
    footer: ["_To fix one: change its type to a Task or Bug and link it to the epic, or fold the work into its parent ticket and close it._"],
  });
  if (!(await deliver(dest, text))) return;
  // counts only: this repo's CI logs are public
  console.log("Posted: " + shown + " of " + n + " sub-tasks across " + groups.length + " people.");
})().catch(e => { console.error(e.message || e); process.exit(1); });
