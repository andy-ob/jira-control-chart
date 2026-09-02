// Builds dashboard.html from template.html plus the fetched data.
// Inputs:  data/cpao-win-*.jsonl — light issue records (one JSON object per line)
//          data/cpao-log-*.jsonl — {key, transitions:[[from,to,atISO],...]} (optional;
//                                   without them the page labels itself lead time)
//          data/meta.json        — window dates, JQL, project totals (from fetch-issues.js)
// Output:  dashboard.html (the page GitHub Pages serves as index.html).
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const dataDir = path.join(dir, "data");

function readJsonl(pattern) {
  const out = [];
  const files = fs.readdirSync(dataDir).filter(f => pattern.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dataDir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      // A bad line means a corrupt input file — fail the build rather than
      // silently publishing a chart with records missing.
      try { out.push(JSON.parse(t)); } catch (e) { throw new Error("bad JSONL line in " + f + ": " + t.slice(0, 80)); }
    }
  }
  return out;
}

const metaPath = path.join(dataDir, "meta.json");
if (!fs.existsSync(metaPath)) {
  console.error("data/meta.json missing — run fetch-issues.js first.");
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

const issuesRaw = readJsonl(/^cpao-win-\d+\.jsonl$/);
const logsRaw = readJsonl(/^cpao-log-\d+\.jsonl$/);
if (!issuesRaw.length) {
  console.error("no issue records in data/cpao-win-*.jsonl — refusing to build an empty dashboard.");
  process.exit(1);
}

const logByKey = {};
logsRaw.forEach(l => { logByKey[l.key] = l; });

const seen = new Set();
const issues = [];
issuesRaw.forEach(i => {
  if (seen.has(i.key)) return;
  seen.add(i.key);
  issues.push({
    key: i.key, summary: i.summary, type: i.type,
    assignee: i.assignee, assigneeId: i.assigneeId,
    epicKey: i.epicKey || null, epic: i.epic || null,
    created: i.created, resolved: i.resolved,
    status: i.status, statusCategory: i.statusCategory,
    resolution: i.resolution || null
  });
});
issues.sort((a, b) => (a.resolved || "").localeCompare(b.resolved || ""));

const transitions = {};
issues.forEach(i => {
  const l = logByKey[i.key];
  if (!l || !Array.isArray(l.transitions)) return;
  // accept [[from,to,at],...] triples or [{from,to,at},...] objects
  transitions[i.key] = l.transitions.map(t => Array.isArray(t) ? t : [t.from, t.to, t.at]);
});

const missing = issues.filter(i => !transitions[i.key]).length;
console.log("issues:", issues.length, "| with changelog:", Object.keys(transitions).length, "| without:", missing);

// Escape < so no JSON value can close the <script> element or open a tag.
const escapeJs = s => s.replace(/</g, "\\u003c");
const json = escapeJs(JSON.stringify({ issues, transitions }));
const metaJson = escapeJs(JSON.stringify(meta));

let html = fs.readFileSync(path.join(dir, "template.html"), "utf8");
for (const [marker, value] of [
  [/const DATA = .*\/\/ __INJECT__/, "const DATA = " + json + "; // injected"],
  [/const META = .*\/\/ __INJECT_META__/, "const META = " + metaJson + "; // injected"],
]) {
  if (!marker.test(html)) throw new Error("inject marker not found in template.html: " + marker);
  // Function replacement so $-sequences in issue text aren't treated as
  // replace() patterns ($' would splice the rest of the file into the script).
  html = html.replace(marker, () => value);
}
fs.writeFileSync(path.join(dir, "dashboard.html"), html);
console.log("dashboard.html written:", (html.length / 1024).toFixed(0) + "KB");
