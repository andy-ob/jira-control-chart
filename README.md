# CPAO control chart dashboard

Interactive cycle-time control chart for the [CPAO board](https://twinkl.atlassian.net/jira/software/c/projects/CPAO/boards/2286),
rebuilt from the Jira REST API on a rolling 90-day window and published on GitHub Pages.

A scheduled GitHub Actions workflow ([update-dashboard.yml](.github/workflows/update-dashboard.yml))
refreshes the data every weekday at 05:30 UTC: it fetches the issues completed in the
last 90 days, pulls each issue's status history, rebuilds the page, and deploys it to
Pages. It can also be run on demand from the Actions tab, and runs on every push to main.

Defaults, both switchable in the page's filter row:

- Issues that never entered an in-progress status (To Do straight to Done) are excluded,
  with the excluded count shown on the chart.
- Time is measured in **working days**: whole Saturdays and Sundays are subtracted from
  each interval. Public holidays and working hours are not modelled.

## Files

- `template.html` — the page source, with `__INJECT__` (issue data) and `__INJECT_META__`
  (window dates, JQL, project totals) placeholders. Edit this one.
- `build.js` — merges `data/*.jsonl` + `data/meta.json` into the template → `dashboard.html`.
- `fetch-issues.js` — pulls the completed issues for the rolling window and the project
  totals → `data/cpao-win-1.jsonl` + `data/meta.json`.
- `fetch-changelogs.js` — pulls per-issue status history → `data/cpao-log-1.jsonl`.
- `lib.js` — shared credential handling and retrying Jira fetch.
- `test.js` — post-build smoke test; CI runs it before deploying.
- `dashboard.html`, `data/` — generated; gitignored, never committed.

## Running locally

```
npm run refresh    # fetch-issues + fetch-changelogs + build (needs credentials, ~1 min)
npm run build      # rebuild dashboard.html from already-fetched data
```

Then open `dashboard.html` in a browser.

## Credentials

The fetch scripts read `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` from the environment
(this is what CI uses — they are repository Actions secrets). Locally you can instead:

1. Create a token at id.atlassian.com → Security → **API tokens**.
2. Save it in this folder as `.atlassian-token`, a single line: `your.email@twinkl.co.uk:THETOKEN`
3. `chmod 600 .atlassian-token`

The file is gitignored. Never commit or paste the token anywhere else. If it is ever
exposed, revoke it at id.atlassian.com immediately — deleting the file is not enough.

## Aging WIP digest (Google Chat)

Alongside each scheduled refresh, `notify.js` posts a digest to a Google Chat
space: every issue in progress for more than 5 working days (the same
working-day and clock-start rules as the chart), grouped by assignee with an
@mention. Nothing is posted when no issue is over the threshold, and the job
skips quietly if the webhook secret is missing.

- Webhook: repository secret `GCHAT_WEBHOOK_URL` (locally: a `.gchat-webhook`
  file in this folder, gitignored).
- Threshold: `WIP_THRESHOLD_DAYS` in the workflow (default 5).
- Test locally with `DRY_RUN=1 node notify.js` (prints instead of posting) —
  never in CI, where logs are public.

## Publishing notes

The published page is a static snapshot: it contains the issue data baked in, and a
GitHub Pages site is readable by anyone who has the URL (the page carries a `noindex`
robots meta tag, and no Jira data or credentials are committed to the repository —
only the code). Issue links on the page still require Twinkl Atlassian access to open.

To change the window, set `WINDOW_DAYS` when running `fetch-issues.js`; every label,
date and the provenance JQL on the page follow the fetched metadata automatically.

GitHub automatically disables scheduled workflows in public repos after 60 days
without repository activity; it emails a warning first, and the schedule can be
re-enabled with one click on the Actions tab (or kept alive by any commit).
