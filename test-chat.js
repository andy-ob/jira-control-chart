// Offline tests for the Google Chat digest helpers (chat.js): markup
// stripping, mention resolution, grouping order, and the message budget.
// No network, no credentials: safe to run anywhere, including CI.
const { CHAR_BUDGET, clean, groupByAssignee, buildDigest } = require("./chat");
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " " + msg); if (!cond) fails++; };

ok(clean("<users/all> *bold* |pipe| _u_ ~s~ `c`") === "users/all bold pipe u s c", "clean strips every Chat markup character");

const users = { "a@x.test": "111", "b@x.test": "222" };
const T = (key, email, assignee, rank, summary = key) => ({ key, email, assignee, rank, summary, status: "To Do" });
const fmt = t => "• " + t.key + " " + clean(t.summary);

// grouping: by top rank across groups, by rank within; unassigned form their own group
const groups = groupByAssignee([
  T("K-1", "a@x.test", "Ann", 2), T("K-2", null, null, 9), T("K-3", "c@x.test", "Cat", 5), T("K-4", "a@x.test", "Ann", 7),
], t => t.rank);
ok(groups.map(g => g.tickets.map(t => t.key).join(",")).join(" | ") === "K-2 | K-4,K-1 | K-3", "groups ordered by top rank, tickets by rank within");

const d1 = buildDigest({ intro: ["*Title*", "intro:"], groups, users, fmtTicket: fmt });
ok(d1.text.includes("<users/111>") && !d1.text.includes("<users/222>"), "mapped assignee becomes a numeric mention");
ok(d1.text.includes("*Cat*") && d1.text.includes("*Unassigned*"), "unmapped and missing assignees render as bold names");
ok(d1.shown === 4 && !d1.text.includes("more."), "everything fits: no overflow line");

// budget: far too many long tickets stay within CHAR_BUDGET, the overflow is
// counted, the footer survives, and no @mention is left without a ticket
const many = Array.from({ length: 300 }, (_, i) => T("B-" + i, i % 2 ? "a@x.test" : "b@x.test", "P" + (i % 2), i, "x".repeat(70)));
const footer = ["_Plus 12 more elsewhere._"];
const d2 = buildDigest({ intro: ["*Title*", "intro:"], groups: groupByAssignee(many, t => t.rank), users, fmtTicket: fmt, footer });
ok(d2.text.length <= CHAR_BUDGET, `budget respected (${d2.text.length} <= ${CHAR_BUDGET})`);
const m = d2.text.match(/…and (\d+) more\./);
ok(m && Number(m[1]) + d2.shown === 300, "overflow line accounts for every unshown ticket");
ok(d2.text.endsWith(footer[0]), "footer survives truncation");
const lines = d2.text.split("\n");
const lastHeader = lines.map((l, i) => [l, i]).filter(([l]) => /^<users\/\d+>$/.test(l)).pop();
ok(lastHeader && /^• /.test(lines[lastHeader[1] + 1]), "no dangling mention: last header is followed by a ticket");

// injection: markup inside a name or summary cannot mint a mention or bold
const d3 = buildDigest({ intro: ["*T*"], groups: groupByAssignee([T("I-1", null, "Bo <users/all> *x*", 1, "<users/all> *loud*")], t => t.rank), users, fmtTicket: fmt });
ok(!d3.text.includes("<users/all>") && d3.text.split("*").length === 5, "markup in names and summaries is neutralised");

process.exit(fails ? 1 : 0);
