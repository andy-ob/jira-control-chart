// Post-build smoke test: structural checks and injected-data integrity for
// dashboard.html. Run after build.js; CI runs it before deploying, so a
// corrupt build fails the workflow instead of replacing a good page.
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const html = fs.readFileSync(path.join(dir, "dashboard.html"), "utf8");
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + " " + msg); if (!cond) fails++; };

ok(html.trimStart().toLowerCase().startsWith("<!doctype html>"), "doctype present");
ok(html.includes('<meta charset="utf-8">'), "charset meta");
ok(html.includes('name="viewport"'), "viewport meta");
ok(html.includes('name="robots" content="noindex"'), "noindex meta");
ok(html.includes("</body>") && html.includes("</html>"), "closing body/html");

const dataM = html.match(/const DATA = (.*); \/\/ injected/);
const metaM = html.match(/const META = (.*); \/\/ injected/);
ok(!!dataM, "DATA injected");
ok(!!metaM, "META injected");
const DATA = JSON.parse(dataM[1]);
const META = JSON.parse(metaM[1]);

const src = fs.readFileSync(path.join(dir, "data", "cpao-win-1.jsonl"), "utf8")
  .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
ok(DATA.issues.length === src.length, `issue count ${DATA.issues.length} matches source ${src.length}`);
const byKey = Object.fromEntries(src.map(r => [r.key, r]));
let mismatch = 0, badDate = 0;
for (const i of DATA.issues) {
  // byte-identical summaries prove $-sequences survived the template injection
  if (!byKey[i.key] || i.summary !== byKey[i.key].summary) mismatch++;
  for (const t of [i.created, i.resolved]) {
    if (t !== null && (!/Z$/.test(t) || !Number.isFinite(new Date(t).getTime()))) badDate++;
  }
}
ok(mismatch === 0, `summaries byte-identical to source (${mismatch} mismatches)`);
let badTr = 0;
for (const trs of Object.values(DATA.transitions)) {
  for (const [, , at] of trs) if (!/Z$/.test(at) || !Number.isFinite(new Date(at).getTime())) badTr++;
}
ok(badDate === 0 && badTr === 0, `all timestamps ISO-UTC and parseable (${badDate} issue, ${badTr} transition bad)`);
ok(META.projectTotals.all > 0 && META.jql.includes(META.windowStart), "META coherent");

const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
try { new Function(script); ok(true, "inline script parses"); } catch (e) { ok(false, "inline script parses: " + e.message); }

process.exit(fails ? 1 : 0);
