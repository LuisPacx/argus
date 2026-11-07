// Deploy the public team site (docs/team/site/) to Cloudflare Pages project argus-overview, recording the git commit.
//
// Usage:   node <checkout>/scripts/deploy-site.mjs   (deploys the checkout or worktree the script lives in, from any cwd)
//
// - Refuses if docs/team/site/ has uncommitted changes, so the deployed files always match HEAD.
// - Resolves the sha and commit message from the repo it is run in and passes them to wrangler with --commit-dirty=false,
//   so wrangler never runs git itself (it would run in the scratch dir below, which cannot see this repo's commits).
// - Deploys as the Pages production branch (`main`) whatever branch is checked out; the checked-out branch is only printed.
// - Hides git from wrangler (GIT_CEILING_DIRECTORIES), since $HOME is a git repo that wrangler would otherwise probe.
// - Runs wrangler with cwd ~/.cache/argus-scratch/site-deploy, never the repo: npm/npx in a checkout once overwrote package.json.
//   That directory must already exist and be logged in to Cloudflare.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'argus-overview';
const PRODUCTION_BRANCH = 'main';
const SITE = 'docs/team/site';
const SCRATCH = path.join(os.homedir(), '.cache/argus-scratch/site-deploy');

// The checkout is the one this script lives in, wherever it is run from.
const here = path.dirname(fileURLToPath(import.meta.url));
const git = (...args) => execFileSync('git', ['-C', here, ...args], { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`deploy-site: ${message}`);
  process.exit(1);
};

const root = git('rev-parse', '--show-toplevel');
const siteDir = path.join(root, SITE);
if (!fs.existsSync(siteDir)) fail(`${siteDir} does not exist`);
if (!fs.existsSync(SCRATCH)) fail(`scratch dir ${SCRATCH} does not exist`);

const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--ignored', '--', SITE], { encoding: 'utf8' }).trim();
if (dirty) fail(`${SITE}/ has uncommitted changes; commit or revert them first:\n${dirty}`);

const sha = git('rev-parse', 'HEAD');
const message = git('log', '-1', '--format=%s');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`Deploying ${SITE}/ from ${sha.slice(0, 7)} on ${branch} to ${PROJECT} (${PRODUCTION_BRANCH}): ${message}`);

const result = spawnSync(
  'npx',
  [
    'wrangler', 'pages', 'deploy', siteDir,
    '--project-name', PROJECT,
    `--branch=${PRODUCTION_BRANCH}`,
    `--commit-hash=${sha}`,
    `--commit-message=${message}`,
    '--commit-dirty=false',
  ],
  // The home dir is itself a git repo, so wrangler's git probes in the scratch dir would find it (and warn it is dirty).
  // The ceiling hides it; the commit details are all passed explicitly.
  { cwd: SCRATCH, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: os.homedir() } },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) fail(`wrangler exited with status ${result.status}`);

const url = ((result.stdout ?? '') + (result.stderr ?? '')).match(/https:\/\/[a-z0-9-]+\.argus-overview\.pages\.dev/g)?.at(-1);
console.log(url ? `Deployment URL: ${url}` : 'deploy-site: could not find the deployment URL in wrangler output');
