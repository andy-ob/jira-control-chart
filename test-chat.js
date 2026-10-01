// Offline tests for the Google Chat digest helpers (chat.js): markup
// stripping, mention resolution, grouping order, the message budget, and
// pull request links. No network, no credentials: safe to run anywhere,
// including CI.
const { CHAR_BUDGET, clean, groupByAssignee, buildDigest, prLinks } = require("./chat");
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

// PR links: open and draft PRs are linked with the ticket's own first, merged
// and declined ones (Jira attaches every PR whose commits mention the key)
// are dropped, a merged-only ticket gets a note, and only clean github.com
// URLs become links
const P = (n, status, branch, updated, repo = "twinkltech/twinkl-web", url = "https://github.com/twinkltech/twinkl-web/pull/" + n) =>
  ({ id: "#" + n, name: "", url, repo, status, branch, updated });
ok(prLinks([], "K-1") === "" && prLinks([P(1, "DECLINED", "feat/K-1-x", "2026-01-01")], "K-1") === "", "nothing open and nothing merged: no suffix");
ok(prLinks([P(1, "MERGED", "feat/K-1-x", "2026-01-01")], "K-1") === " · PR merged", "merged-only ticket gets a note, not a link");
const s1 = prLinks([
  P(7, "OPEN", "fix/NOTICKET-other", "2026-03-01"),
  P(5, "DRAFT", "feat/K-1-thing", "2026-02-01"),
  P(9, "MERGED", "feat/K-1-done", "2026-04-01"),
], "K-1");
ok(s1 === " · PRs <https://github.com/twinkltech/twinkl-web/pull/5|twinkl-web#5> (draft), <https://github.com/twinkltech/twinkl-web/pull/7|twinkl-web#7>",
  "ticket's own PR first, draft marked, merged dropped, org stripped from the label");
const s2 = prLinks([P(1, "OPEN", "a", "2026-01-01"), P(2, "OPEN", "b", "2026-01-02"), P(3, "OPEN", "c", "2026-01-03")], "K-1");
ok(s2.includes("#3>, ") && s2.includes("#2>") && !s2.includes("#1>") && s2.endsWith(" +1"), "capped at the two newest with a +N for the rest");
const s3 = prLinks([P(6, "OPEN", "feat/K-12-x", "2026-02-01"), P(8, "OPEN", "feat/K-1-y", "2026-01-01")], "K-1");
ok(s3.indexOf("#8>") < s3.indexOf("#6>"), "key match is whole-key: K-12 does not count as K-1");
ok(prLinks([P(4, "OPEN", "x", "2026-01-01", "twinkltech/x", "https://evil.example/pull/4|<users/all>")], "K-1") === "", "a non-GitHub or markup-carrying URL is never linked");
const s4 = prLinks([P(4, "OPEN", "x", "2026-01-01", "twinkltech/*bold*")], "K-1");
ok(s4.includes("|bold#4>") && !s4.includes("*"), "markup in a repo name is stripped from the link text");

process.exit(fails ? 1 : 0);
