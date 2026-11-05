#!/usr/bin/env node
// gorphan: delete merged / squash-merged / stale local branches from an interactive list, or by name.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { checkbox, confirm } from '@inquirer/prompts';

const LOG = join(homedir(), '.gorphan.log');
const PROTECTED = ['main', 'master', 'develop', 'dev', 'staging'];

const die = (msg) => { console.error(styleText('red', msg)); process.exit(1); };

let opt, targets;
try {
  ({ values: opt, positionals: targets } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      'no-fetch': { type: 'boolean' },
      'no-gh': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      merged: { type: 'boolean' },
      gone: { type: 'boolean' },
      days: { type: 'string', default: '30' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  die(`${e.message.split('.')[0]}. Run "gorphan -h" for usage.`);
}

if (opt.help) {
  console.log(`Usage:
  gorphan                  pick branches to delete from a list
  gorphan <branch>...      delete these branches

Options:
  --merged     only branches merged into the default branch (incl. squash merges)
  --gone       only branches whose upstream (remote branch) is gone
  --dry-run    show what would be deleted, delete nothing
  -y, --yes    delete without the confirmation prompt:
                 no filter: all merged branches (stale ones are never auto-deleted)
                 --merged / --gone: everything that filter lists
                 branch names: also unmerged ones
  --no-fetch   skip "git fetch --prune"
  --no-gh      skip the squash-merge check via GitHub CLI
  --days N     no commit for N days = stale (default 30)

Deleted branches are logged to ${LOG}; restore one with: git branch <name> <sha>`);
  process.exit(0);
}
const filtered = opt.merged || opt.gone;
if (filtered && targets.length) die('--merged / --gone work on the list, not together with branch names.');

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const git = (...args) => { const r = run('git', args); return r.status === 0 ? r.stdout.trim() : ''; };

if (git('rev-parse', '--is-inside-work-tree') !== 'true') die('Not inside a git repository.');

function defaultBranch() {
  const ref = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'); // origin/main
  if (ref) return ref.split('/').slice(1).join('/');
  return ['main', 'master'].find((b) => git('rev-parse', '--verify', '--quiet', b)) || die('No main/master branch found.');
}

// { branch: headSha } of merged PRs. Catches squash merges, which `git branch --merged` misses.
let prs;
function mergedPRs() {
  if (prs) return prs;
  if (opt['no-gh']) return (prs = {});
  const r = run('gh', ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'headRefName,headRefOid']);
  if (r.error || r.status !== 0) {
    console.log(styleText('dim', '(squash-merge check skipped: gh not installed or not logged in)'));
    return (prs = {});
  }
  return (prs = Object.fromEntries(JSON.parse(r.stdout).map((p) => [p.headRefName, p.headRefOid])));
}

const mainBranch = defaultBranch();
if (!opt['no-fetch']) {
  console.log(styleText('dim', 'Fetching from origin...'));
  run('git', ['fetch', '--prune', '--quiet']);
}
const base = git('rev-parse', '--verify', '--quiet', `origin/${mainBranch}`) ? `origin/${mainBranch}` : mainBranch;
const current = git('branch', '--show-current');
const merged = new Set(git('branch', '--merged', base, '--format=%(refname:short)').split('\n'));
const staleDays = Number(opt.days);

const branches = new Map();
const fmt = '%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(upstream:track)\t%(worktreepath)';
for (const line of git('for-each-ref', `--format=${fmt}`, 'refs/heads/').split('\n').filter(Boolean)) {
  const [name, sha, ts, track, worktree] = line.split('\t');
  const lock = name === current ? 'it is the current branch'
    : worktree ? `it is checked out in ${worktree}`
    : name === mainBranch || PROTECTED.includes(name) ? 'it is a protected branch' : null;
  const days = Math.floor((Date.now() / 1000 - Number(ts)) / 86400);
  branches.set(name, { name, sha, days, gone: track === '[gone]', lock });
}

function statusOf(r) {
  if (merged.has(r.name)) return 'merged';
  if (mergedPRs()[r.name] === r.sha) return 'squashed'; // PR merged and local tip == PR head
  if (r.days > staleDays || r.gone) return 'stale';
  return 'active';
}

const LABEL = {
  merged: styleText('green', '✅ Merged'),
  squashed: styleText('green', '✅ Squash-merged'),
  stale: styleText('yellow', '⚠️  Stale'),
  active: styleText('blue', '🔵 Active'),
};
const isMerged = (r) => r.status === 'merged' || r.status === 'squashed';
let w = 6;
const line = (r) => `${r.name.padEnd(w)}${`${r.days} days ago`.padStart(14)}   ${LABEL[r.status]}${r.gone ? styleText('dim', '  (remote gone)') : ''}`;

function remove(r) {
  // -D, not -d: -d checks against the upstream or HEAD, not origin/main, so it rejects branches we already
  // verified as merged (e.g. upstream [gone] while you're on a feature branch). Merged status is checked
  // against origin/main above, anything else was confirmed by the user, and the sha is logged for restore.
  const res = run('git', ['branch', '-D', r.name]);
  if (res.status !== 0) return console.log(styleText('red', `  ✗ ${r.name}: ${res.stderr.trim()}`));
  appendFileSync(LOG, `${new Date().toISOString()}  ${process.cwd()}  git branch ${r.name} ${r.sha}\n`);
  console.log(`  🗑  ${r.name} ${styleText('dim', r.sha.slice(0, 8))}`);
}

const restoreHint = () => console.log(styleText('dim', `\nLog: ${LOG} (restore any branch with: git branch <name> <sha>)`));
const interactive = process.stdin.isTTY && !opt.yes && !opt['dry-run'];

async function sweepNamed() {
  for (const name of targets) {
    const r = branches.get(name);
    if (!r) { console.log(styleText('red', `  ✗ ${name}: no such local branch`)); continue; }
    if (r.lock) { console.log(styleText('red', `  ✗ ${name}: not deleting, ${r.lock}`)); continue; }
    r.status = statusOf(r);
    if (opt['dry-run']) { console.log(`  ${name}: ${LABEL[r.status]}, would ${isMerged(r) ? '' : 'need confirmation to '}delete`); continue; }
    if (!isMerged(r) && !opt.yes) {
      if (!interactive) { console.log(styleText('red', `  ✗ ${name}: not merged into ${base}; use --yes to delete anyway`)); continue; }
      const msg = `${name} is NOT merged into ${base} (last commit ${r.days} days ago). Delete anyway?`;
      if (!(await confirm({ message: msg, default: false }))) continue;
    }
    remove(r);
  }
}

async function sweepList() {
  let rows = [...branches.values()].filter((r) => !r.lock);
  const ORDER = { merged: 0, squashed: 1, stale: 2, active: 3 };
  for (const r of rows) r.status = statusOf(r);
  if (filtered) rows = rows.filter((r) => (opt.merged && isMerged(r)) || (opt.gone && r.gone));
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.days - a.days);
  w = Math.max(6, ...rows.map((r) => r.name.length)) + 2;

  const count = (...s) => rows.filter((r) => s.includes(r.status)).length;
  const only = filtered ? `, only ${[opt.merged && 'merged', opt.gone && 'gone'].filter(Boolean).join(' + ')}` : '';
  const summary = `${count('merged', 'squashed')} merged, ${count('stale')} stale, ${count('active')} active (compared with ${base}${only})`;

  if (!interactive) { // --dry-run, --yes or piped: plain table
    console.log(styleText('bold', `\n ${'Branch'.padEnd(w)}${'Last commit'.padStart(14)}   Status`));
    console.log(' ' + '─'.repeat(w + 34));
    for (const r of rows) console.log(` ${line(r)}`);
    console.log(`\n${summary}\n`);
    if (opt['dry-run']) return;
    if (!opt.yes) die('Not an interactive terminal. Use --dry-run to list or --yes to delete merged branches.');
    const toDelete = filtered ? rows.filter((r) => r.status !== 'active') : rows.filter(isMerged);
    if (!toDelete.length) return console.log('Nothing to delete.');
    toDelete.forEach(remove);
    return restoreHint();
  }

  if (!rows.some((r) => r.status !== 'active')) return console.log(`\n${summary}. Nothing to delete.`);
  console.log(`\n${summary}`);
  const selected = await checkbox({
    message: 'Select branches to delete',
    pageSize: 20,
    loop: false,
    choices: rows.map((r) => ({
      name: line(r),
      short: r.name,
      value: r,
      checked: filtered || isMerged(r), // with --merged/--gone you asked for exactly these
      disabled: r.status === 'active' ? ' ' : false, // shown but can't be selected
    })),
  });
  if (!selected.length) return;
  const unmerged = selected.filter((r) => !isMerged(r)).length;
  const warn = unmerged ? styleText('yellow', ` (${unmerged} not merged!)`) : '';
  if (!(await confirm({ message: `Delete ${selected.length} branch${selected.length === 1 ? '' : 'es'}${warn}?`, default: false }))) return;
  selected.forEach(remove);
  restoreHint();
}

try {
  await (targets.length ? sweepNamed() : sweepList());
} catch (e) {
  if (e.name !== 'ExitPromptError') throw e; // Ctrl+C in a prompt: just quit
}
