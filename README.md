# git-recap

AI-powered weekly standups. Summarises active branches and commits using GitHub Copilot.

## Generate a work summary issue

This repository includes a Node.js utility script at `scripts/generate-work-summary.js` that:

1. Collects commits from a configurable date range (default: last 7 days)
2. Scans default branches and active, unmerged feature branches
3. Filters commit authors to your authenticated GitHub account plus `github-copilot[bot]`
4. Sends grouped commit data to GitHub Models (`gpt-4o`) for markdown summarization
5. Creates a new GitHub Issue titled `Work Summary: [Start Date] - [End Date]`

### Environment variables

The script reads `.emv` first (as requested), then `.env`, then existing shell env vars.

- `GITHUB_TOKEN` (required): Used for both GitHub API and GitHub Models API calls
- `RECAP_REPOSITORIES` (required unless passed as `--repos`): JSON array, e.g. `[{"owner":"user","repo":"repo-1"}]`
- `RECAP_START_DATE` (optional): ISO date/time, e.g. `2026-05-01`
- `RECAP_END_DATE` (optional): ISO date/time, e.g. `2026-05-31`
- `ISSUE_OWNER` and `ISSUE_REPO` (optional): Target repository for issue creation
  - If omitted, `GITHUB_REPOSITORY` is used automatically (useful in GitHub Actions)

### Install and run

```bash
cd path/to/git-recap
npm install
npm run generate:summary -- \
  --repos '[{"owner":"user","repo":"repo-1"}]' \
  --start '2026-05-01' \
  --end '2026-05-31' \
  --issue-owner 'akhuoa' \
  --issue-repo 'git-recap'
```

Optional:

- Add `--dry-run` to print the generated markdown summary without creating an issue.
