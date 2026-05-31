#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Octokit } = require('@octokit/rest');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const COPILOT_AUTHOR = 'github-copilot[bot]';
const SYSTEM_PROMPT =
  "You are an executive engineering assistant. Summarize the user's recent git commit history into a clean, professional, markdown-formatted status report categorized by repository and impact.";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    i += 1;
  }

  return args;
}

function parseDateInput(input, fallback) {
  if (!input) {
    return fallback;
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${input}`);
  }

  return parsed;
}

function dateInRange(dateInput, startDate, endDate) {
  if (!dateInput) {
    return false;
  }

  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date >= startDate && date <= endDate;
}

function normalizeRepoList(rawValue) {
  if (!rawValue) {
    throw new Error(
      'Missing repositories input. Provide --repos or RECAP_REPOSITORIES as JSON (e.g. [{"owner":"user","repo":"repo-1"}]).'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`Could not parse repositories JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Repositories input must be a non-empty JSON array.');
  }

  for (const repoObj of parsed) {
    if (!repoObj || typeof repoObj.owner !== 'string' || typeof repoObj.repo !== 'string') {
      throw new Error('Each repository object must include string fields: owner and repo.');
    }
  }

  return parsed;
}

function getCommitDate(commit) {
  return (
    commit?.commit?.author?.date ||
    commit?.commit?.committer?.date ||
    commit?.author?.date ||
    commit?.committer?.date ||
    null
  );
}

function getAuthorLogin(commit) {
  if (commit?.author?.login) {
    return commit.author.login;
  }

  const fromRaw = commit?.commit?.author?.name;
  return typeof fromRaw === 'string' ? fromRaw : null;
}

function commitMatchesFilters(commit, startDate, endDate, allowedAuthors) {
  const commitDate = getCommitDate(commit);
  if (!dateInRange(commitDate, startDate, endDate)) {
    return false;
  }

  const login = getAuthorLogin(commit);
  if (!login) {
    return false;
  }

  return allowedAuthors.has(login.toLowerCase());
}

function dedupeAndSortCommits(commits) {
  const unique = new Map();
  for (const commit of commits) {
    if (commit?.sha && !unique.has(commit.sha)) {
      unique.set(commit.sha, commit);
    }
  }

  return Array.from(unique.values()).sort((a, b) => {
    const dateA = new Date(getCommitDate(a) || 0).getTime();
    const dateB = new Date(getCommitDate(b) || 0).getTime();
    return dateA - dateB;
  });
}

async function collectDefaultBranchCommits(octokit, repoConfig, startDate, endDate, allowedAuthors) {
  const { owner, repo, defaultBranch } = repoConfig;

  const commits = await octokit.paginate(octokit.repos.listCommits, {
    owner,
    repo,
    sha: defaultBranch,
    since: startDate.toISOString(),
    until: endDate.toISOString(),
    per_page: 100,
  });

  return commits.filter((commit) => commitMatchesFilters(commit, startDate, endDate, allowedAuthors));
}

async function isBranchHeadRecent(octokit, owner, repo, branchName, startDate, endDate) {
  const { data: headCommit } = await octokit.repos.getCommit({
    owner,
    repo,
    ref: branchName,
  });

  return dateInRange(getCommitDate(headCommit), startDate, endDate);
}

async function collectFeatureBranchCommits(octokit, repoConfig, startDate, endDate, allowedAuthors) {
  const { owner, repo, defaultBranch } = repoConfig;

  const branches = await octokit.paginate(octokit.repos.listBranches, {
    owner,
    repo,
    per_page: 100,
  });

  const branchMap = {};

  for (const branch of branches) {
    if (branch.name === defaultBranch) {
      continue;
    }

    const recentHead = await isBranchHeadRecent(
      octokit,
      owner,
      repo,
      branch.name,
      startDate,
      endDate
    );

    if (!recentHead) {
      continue;
    }

    const { data: comparison } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${defaultBranch}...${branch.name}`,
      per_page: 100,
    });

    if ((comparison?.ahead_by ?? 0) <= 0) {
      continue;
    }

    const matching = (comparison.commits || []).filter((commit) =>
      commitMatchesFilters(commit, startDate, endDate, allowedAuthors)
    );

    if (matching.length > 0) {
      branchMap[branch.name] = dedupeAndSortCommits(matching);
    }
  }

  return branchMap;
}

function buildSummaryInput(groupedCommits, startDate, endDate) {
  const lines = [
    `Timeframe: ${startDate.toISOString()} to ${endDate.toISOString()}`,
    '',
    'Commit activity grouped by repository and branch:',
  ];

  for (const repoName of Object.keys(groupedCommits).sort()) {
    lines.push('');
    lines.push(`Repository: ${repoName}`);

    const branches = groupedCommits[repoName];
    const branchNames = Object.keys(branches).sort();

    if (branchNames.length === 0) {
      lines.push('- No matching commits found.');
      continue;
    }

    for (const branchName of branchNames) {
      lines.push(`- Branch: ${branchName}`);
      for (const commit of branches[branchName]) {
        const sha = commit.sha ? commit.sha.slice(0, 7) : 'unknown';
        const message = (commit?.commit?.message || '').split('\n')[0].trim() || '(no message)';
        const author = getAuthorLogin(commit) || 'unknown';
        const date = getCommitDate(commit) || 'unknown-date';
        lines.push(`  - [${sha}] ${message} (author: ${author}, date: ${date})`);
      }
    }
  }

  return lines.join('\n');
}

async function summarizeWithAi(token, summaryInput) {
  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: ['Bearer', token].join(' '),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: summaryInput },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub Models API request failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('GitHub Models API returned an unexpected response format.');
  }

  return content;
}

function resolveIssueTarget(args) {
  if (args['issue-owner'] && args['issue-repo']) {
    return { owner: args['issue-owner'], repo: args['issue-repo'] };
  }

  if (process.env.ISSUE_OWNER && process.env.ISSUE_REPO) {
    return { owner: process.env.ISSUE_OWNER, repo: process.env.ISSUE_REPO };
  }

  if (process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }

  throw new Error(
    'Issue target repository is not set. Provide --issue-owner and --issue-repo, set ISSUE_OWNER/ISSUE_REPO, or run in GitHub Actions with GITHUB_REPOSITORY.'
  );
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.emv'));
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const args = parseArgs(process.argv);
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('Missing GITHUB_TOKEN environment variable.');
  }

  const endDate = parseDateInput(args.end || process.env.RECAP_END_DATE, new Date());
  const startFallback = new Date(endDate.getTime() - DEFAULT_DAYS * MS_PER_DAY);
  const startDate = parseDateInput(args.start || process.env.RECAP_START_DATE, startFallback);

  if (startDate > endDate) {
    throw new Error('Start date must be earlier than or equal to end date.');
  }

  const repos = normalizeRepoList(args.repos || process.env.RECAP_REPOSITORIES);
  const issueTarget = resolveIssueTarget(args);
  const octokit = new Octokit({ auth: token });

  const authenticated = await octokit.users.getAuthenticated();
  const username = authenticated?.data?.login;

  if (!username) {
    throw new Error('Could not resolve authenticated GitHub username.');
  }

  const allowedAuthors = new Set([username.toLowerCase(), COPILOT_AUTHOR]);
  const groupedCommits = {};

  for (const repo of repos) {
    const key = `${repo.owner}/${repo.repo}`;

    const { data: repoData } = await octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });

    const defaultBranch = repoData.default_branch;
    if (!defaultBranch) {
      groupedCommits[key] = {};
      continue;
    }

    const repoConfig = {
      owner: repo.owner,
      repo: repo.repo,
      defaultBranch,
    };

    const branchMap = {};

    const defaultBranchCommits = await collectDefaultBranchCommits(
      octokit,
      repoConfig,
      startDate,
      endDate,
      allowedAuthors
    );

    if (defaultBranchCommits.length > 0) {
      branchMap[defaultBranch] = dedupeAndSortCommits(defaultBranchCommits);
    }

    const featureBranches = await collectFeatureBranchCommits(
      octokit,
      repoConfig,
      startDate,
      endDate,
      allowedAuthors
    );

    Object.assign(branchMap, featureBranches);
    groupedCommits[key] = branchMap;
  }

  const promptInput = buildSummaryInput(groupedCommits, startDate, endDate);
  const markdownSummary = await summarizeWithAi(token, promptInput);

  const title = `Work Summary: ${startDate.toISOString().slice(0, 10)} - ${endDate
    .toISOString()
    .slice(0, 10)}`;

  if (args.dryRun) {
    console.log('Dry run mode enabled. Issue not created.');
    console.log(`Target issue repository: ${issueTarget.owner}/${issueTarget.repo}`);
    console.log(`Issue title: ${title}`);
    console.log('\n--- AI SUMMARY ---\n');
    console.log(markdownSummary);
    return;
  }

  const { data: issue } = await octokit.issues.create({
    owner: issueTarget.owner,
    repo: issueTarget.repo,
    title,
    body: markdownSummary,
  });

  console.log(`Created issue #${issue.number}: ${issue.html_url}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
