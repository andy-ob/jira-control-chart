// Google Chat webhook helpers shared by the digest scripts (notify.js,
// notify-epics.js): where a digest goes (webhook URL, DRY_RUN and CI guards),
// the email → Google user ID mention map, Chat-markup-safe text, assembling a
// per-assignee digest within Chat's message size, and a retrying POST.
//
// Webhook: GCHAT_WEBHOOK_URL env var (CI secret) or .gchat-webhook file
// (local, gitignored, one line: the full webhook URL).
// DRY_RUN=1 prints the message instead of posting. Local use only: it prints
// ticket titles and names, and CI logs on this public repo are world-readable.
//
// Deliberately independent of lib.js, which exits at load time without Jira
// credentials, so these helpers can be unit-tested offline (test-chat.js).
const fs = require("fs");
const path = require("path");

const CHAR_BUDGET = 3800; // Chat truncates text at 4096 chars; keep headroom
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jira text lands inside Chat markup: strip the characters Chat parses so a
// summary can't inject a mention (<users/all>), break a link, or toggle bold.
const clean = s => String(s || "").replace(/[<>|*_~`]/g, "");
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function webhookUrl() {
  if (process.env.GCHAT_WEBHOOK_URL) return process.env.GCHAT_WEBHOOK_URL;
  const f = path.join(__dirname, ".gchat-webhook");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  return null;
}

// email → numeric Google user ID. Chat webhooks only resolve <users/ID>
// mentions (verified live: the email form renders as literal text), and the
// webhook itself can't look IDs up, so they're maintained as a small map:
// GCHAT_USER_MAP secret in CI, .gchat-users JSON file locally. Unmapped
// assignees fall back to a bold name (visible, but no ping).
function userMap() {
  try {
    if (process.env.GCHAT_USER_MAP) return JSON.parse(process.env.GCHAT_USER_MAP);
    const f = path.join(__dirname, ".gchat-users");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error("Ignoring unparseable user map: " + e.message);
  }
  return {};
}

// Resolve where a digest goes: { url, dry }. Returns null when nothing is
// configured locally (skip quietly). In CI a missing secret is a failure, so
// it can't rot into a silently green no-op.
function target() {
  const dry = process.env.DRY_RUN === "1";
  if (dry && process.env.CI) {
    console.error("DRY_RUN prints ticket data and CI logs are public — refusing.");
    process.exit(1);
  }
  const url = webhookUrl();
  if (!url && !dry) {
    if (process.env.CI) {
      console.error("GCHAT_WEBHOOK_URL secret is not set — failing so the gap is visible.");
      process.exit(1);
    }
    console.log("No GCHAT_WEBHOOK_URL configured — skipping notify.");
    return null;
  }
  return { url, dry };
}

// Group tickets by assignee (email, else display name, else unassigned).
// rank(ticket) is a number: tickets sort highest rank first within a group,
// and groups by their top ticket, so the most pressing item leads the message.
function groupByAssignee(tickets, rank) {
  const groups = new Map();
  for (const t of tickets) {
    const gk = t.email || t.assignee || "__unassigned";
    if (!groups.has(gk)) groups.set(gk, { email: t.email, name: t.assignee, tickets: [] });
    groups.get(gk).tickets.push(t);
  }
  const ordered = [...groups.values()];
  ordered.forEach(g => g.tickets.sort((a, b) => rank(b) - rank(a)));
  ordered.sort((a, b) => rank(b.tickets[0]) - rank(a.tickets[0]));
  return ordered;
}

// Assemble a digest within CHAR_BUDGET: intro lines, then each group as a
// header (an @mention when the assignee is in the user map, a bold name
// otherwise) followed by its tickets via fmtTicket, then optional footer
// lines. A header is only emitted when at least its first ticket also fits
// (no dangling @mention); whatever doesn't fit becomes "…and N more."
// Returns { text, shown }, shown being how many tickets made it in.
function buildDigest({ intro, groups, users, fmtTicket, footer = [] }) {
  const total = groups.reduce((n, g) => n + g.tickets.length, 0);
  const lines = [...intro, ""];
  let used = lines.join("\n").length;
  let shown = 0;
  // space held back for the "…and N more." line and the footer
  const suffixRoom = 30 + footer.reduce((n, l) => n + l.length + 1, 0);
  outer: for (const g of groups) {
    const id = g.email && users[g.email];
    const header = id ? "<users/" + id + ">" : "*" + clean(g.name || "Unassigned") + "*";
    if (used + header.length + fmtTicket(g.tickets[0]).length + suffixRoom > CHAR_BUDGET) break;
    lines.push(header); used += header.length + 1;
    for (const t of g.tickets) {
      const line = fmtTicket(t);
      if (used + line.length + suffixRoom > CHAR_BUDGET) { lines.push(""); break outer; }
      lines.push(line); used += line.length + 1;
      shown++;
    }
    lines.push(""); used += 1;
  }
  if (shown < total) lines.push("…and " + (total - shown) + " more.");
  if (footer.length) {
    if (lines[lines.length - 1] !== "") lines.push("");
    lines.push(...footer);
  }
  return { text: lines.join("\n").trim(), shown };
}

// POST text to the webhook. One transient blip must not lose the day's
// digest, so 429/5xx and network errors retry three times; 4xx fails fast.
async function post(url, text) {
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
}

// Print the message in a dry run, post it otherwise. Resolves true when posted.
async function deliver({ url, dry }, text) {
  if (dry) {
    console.log("---- DRY RUN — would post: ----\n" + text);
    return false;
  }
  await post(url, text);
  return true;
}

module.exports = { CHAR_BUDGET, clean, trunc, webhookUrl, userMap, target, groupByAssignee, buildDigest, post, deliver };
