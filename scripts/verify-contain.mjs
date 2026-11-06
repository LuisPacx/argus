#!/usr/bin/env node
// `pnpm verify:contain`: shows the Build containment working, against real rootless podman and the real Build image
// (containment design section 9). Not part of `pnpm check`. Prints SKIP and exits 0 when podman, the image or the Build network is
// missing; it never pulls an image, builds one, or creates a network (`pnpm image:build` does those, run by the Operator).
//
// Every container comes from sandbox.ts (`PodmanSandbox.launch`, so the real argv, the real sidecar and the real `stop`), with only
// the command after the image replaced by a probe: no `claude` run, no token, no Anthropic spend. The Build token is a dummy file.
// All containers carry the label argus.build=<this run's id>; the finally block removes exactly the IDs that label finds.
//
// What each check shows (reviewer 07 findings, containment design section 3):
//   HIGH2 credentials readable ........ "host credentials ... not reachable", "no secrets in the environment"
//   HIGH2 writes outside the repo ..... "writes outside the repo and home fail", "nothing runs from /tmp, /var/tmp or /run" (a copied binary and script are refused), "only the repo and home are host mounts"
//   HIGH2 arbitrary code (pnpm/tests) . "unprivileged", "resource caps", "pnpm install of the template lockfile ... through the proxy", argv policy
//   HIGH2 exfiltration ................ "no direct network egress", "the proxy tunnels only the allowlisted hosts", "bundle has no network", "refusals reach the Build log"
//   MED4 grandchildren survive ........ "stop ends the container and every grandchild", "--timeout ends an abandoned container"
//   MED4 template dir writable ........ "the template directory is not mounted at all"
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_VERSION, BUILD_NETWORK, EGRESS_ADDRESS, EGRESS_PORT, EGRESS_ALLOW, PodmanSandbox, DEFAULT_CAPS, TMPFS_DIRS, containerEnv, currentImageTag, imageReady, ownerState, ownerToken } from '../packages/core/src/index.ts';
import { checkRunTokens, judgeProbe } from '../packages/core/src/containment-policy.ts';
import { Teardown, scratchPrefixFor, sweepStaleScratch } from '../packages/core/src/containment-verify.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const podman = process.env.ARGUS_PODMAN_BIN || 'podman';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skip(reason) {
  console.log(`SKIP verify:contain: ${reason}`);
  process.exit(0);
}

// Podman client environment: only what it needs to find its rootless store.
const clientEnv = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR'].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const pm = (args, timeout = 60_000) => spawnSync(podman, args, { env: clientEnv, encoding: 'utf8', timeout });

const version = pm(['--version'], 15_000);
if (version.error || version.status !== 0) skip(`podman is not available (${podman}): ${version.error?.message ?? version.stderr.trim().slice(0, 100)}`);
const image = process.env.ARGUS_BUILD_IMAGE || currentImageTag(ROOT);
if (!(await imageReady(image, podman, clientEnv))) skip(`the Build image ${image} is not present; run \`pnpm image:build\` (this script never pulls or builds)`);
if (pm(['network', 'exists', BUILD_NETWORK.name], 15_000).status !== 0) skip(`the podman network ${BUILD_NETWORK.name} does not exist; run \`pnpm image:build\``);

const results = [];
function report(finding, name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} [${finding}] ${name}${detail ? `: ${detail}` : ''}`);
}

// ---- scratch space on the home disk (never /tmp), and the sandbox under test ----
// The directory name carries this process's owner token, so a later run can tell a dead run's leftovers from a live neighbour's.
const cacheDir = path.join(os.homedir(), '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
sweepStaleScratch(cacheDir, { log: (l) => console.log(l) }); // dirs of runs that were SIGKILLed; "unknown" owners are left alone
const scratch = fs.mkdtempSync(path.join(cacheDir, scratchPrefixFor(ownerToken())));
const repo = path.join(scratch, 'repo');
const homeDir = path.join(scratch, 'home');
const installDir = path.join(scratch, 'install');
const installHome = path.join(scratch, 'install-home');
const workDir = path.join(scratch, 'work');
const binDir = path.join(workDir, 'bin');
for (const d of [repo, homeDir, installDir, installHome, binDir]) fs.mkdirSync(d, { recursive: true });
const tokenPath = path.join(scratch, 'token');
fs.writeFileSync(tokenPath, 'verify-contain-dummy-not-a-real-token\n', { mode: 0o600 });

const BUILD_ID = 900_000 + Math.floor(Math.random() * 99_999);
const SENTINELS = { GH_TOKEN: 'verify-sentinel', ANTHROPIC_API_KEY: 'verify-sentinel', CLOUDFLARE_API_TOKEN: 'verify-sentinel', ARGUS_VERIFY_SENTINEL: '1' };
const sandbox = new PodmanSandbox({ image, podmanBin: podman, tokenPath, dataDir: scratch, env: { ...process.env, ...SENTINELS } });

// One cleanup, shared by the signal handlers and the final block; once it has started nothing launches another container.
let leftovers = [];
const teardown = new Teardown(finishCleanup);
const children = []; // every podman client spawned
const seenIds = new Set();
const snapshotIds = () => {
  for (const id of pm(['ps', '-a', '-q', '--no-trunc', '--filter', `label=argus.build=${BUILD_ID}`]).stdout.split('\n').filter(Boolean)) seenIds.add(id);
};

const job = (role, over) => ({ role, buildId: BUILD_ID, cwd: repo, mounts: [repo], home: homeDir, args: [], timeoutMs: 120_000, ...over });

/** Launches `job` through the real sandbox, replaces the command after the image with `cmd`, and spawns the podman client. */
async function start(j, cmd, { detach = false, timeoutSec } = {}) {
  const run = await teardown.launch((signal) => sandbox.launch({ ...j, signal }));
  let args = run.args.slice(0, run.args.indexOf(image) + 1);
  if (timeoutSec !== undefined) args = args.map((a) => (a.startsWith('--timeout=') ? `--timeout=${timeoutSec}` : a));
  if (detach) args.splice(1, 0, '-d');
  args.push(...cmd);
  const child = spawn(run.command, args, { env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const name = args[args.indexOf('--name') + 1];
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const timer = setTimeout(() => child.kill('SIGKILL'), j.timeoutMs);
  done.then(() => clearTimeout(timer));
  return { run, child, name, done, argv: run.args };
}

const containerExists = (name) => pm(['container', 'exists', name], 15_000).status === 0;
async function until(pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(200);
  }
  return Boolean(await pred());
}

/** Host pids of processes whose argv is `sleep <one of durations>`: a container's processes are visible in the rootless user's /proc. */
function hostSleeps(durations) {
  const found = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0');
      if (argv[0]?.endsWith('sleep') && durations.includes(argv[1])) found.push(Number(e));
    } catch {
      // Exited while scanning.
    }
  }
  return found;
}

// ---- the probe that runs inside the agent container ----
const probeScript = (cfg) => `
const fs=require('fs'),net=require('net'),dns=require('dns'),cp=require('child_process');
const CFG=${JSON.stringify(cfg)};
const R={uid:process.getuid(),home:process.env.HOME,envNames:Object.keys(process.env),paths:{},writes:{},mounts:{},tmpfsKiB:{},cgroup:{},direct:{},proxy:{},tools:{}};
const st=fs.readFileSync('/proc/self/status','utf8');
for(const f of ['CapEff','CapBnd','CapPrm','CapInh'])R['cap'+f.slice(3)]=new RegExp(f+':\\\\s*(\\\\S+)').exec(st)[1];R.noNewPrivs=/NoNewPrivs:\\s*(\\S+)/.exec(st)[1];
for(const p of CFG.hostPaths)R.paths[p]=fs.existsSync(p);
for(const d of CFG.writeDirs){try{const f=d.replace(/\\/$/,'')+'/.verify-contain-probe';fs.writeFileSync(f,'x');fs.unlinkSync(f);R.writes[d]=true}catch{R.writes[d]=false}}
R.execFrom={};
for(const d of CFG.execDirs){const o={copied:false,ran:false};
 for(const kind of ['binary','script']){const f=d+'/.verify-contain-exec-'+kind;
  try{if(kind==='binary')fs.copyFileSync('/bin/true',f);else fs.writeFileSync(f,'#!/bin/sh\\nexit 0\\n');fs.chmodSync(f,0o755);o.copied=true;cp.execFileSync(f);o.ran=true}catch{}
  try{fs.unlinkSync(f)}catch{}}
 R.execFrom[d]=o}
for(const l of fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n')){const f=l.split(' ');if(f.length>5){R.mounts[f[4]]=f[5];const i=f.indexOf('-');const m=i>0&&/(?:^|,)size=(\\d+)k(?:,|$)/.exec(f[i+3]||'');if(m)R.tmpfsKiB[f[4]]=Number(m[1])}}
for(const [k,f] of [['memoryMax','memory.max'],['pidsMax','pids.max'],['cpuMax','cpu.max']]){try{R.cgroup[k]=fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim()}catch{}}
for(const t of ['gh','ssh','curl','wget','wrangler','git','node','pnpm','claude'])R.tools[t]=process.env.PATH.split(':').some((d)=>fs.existsSync(d+'/'+t));
const conn=(host,port)=>new Promise((res)=>{const s=net.connect({host,port,timeout:4000});s.on('connect',()=>{s.destroy();res(true)});s.on('timeout',()=>{s.destroy();res(false)});s.on('error',()=>res(false))});
const ask=(raw)=>new Promise((res)=>{const s=net.connect({host:CFG.proxyHost,port:CFG.proxyPort,timeout:10000});let b='';s.on('connect',()=>s.write(raw));s.on('data',(d)=>{b+=d;const i=b.indexOf('\\r\\n');if(i>=0){s.destroy();res(b.slice(0,i))}});s.on('timeout',()=>{s.destroy();res('timeout')});s.on('error',()=>res(b?b.split('\\r\\n')[0]:'closed'));s.on('close',()=>res(b?b.split('\\r\\n')[0]:'closed'))});
(async()=>{
 for(const t of CFG.directTargets){const [h,p]=t.split(':');R.direct[t]=await conn(h,Number(p))}
 R.direct['example.com (dns)']=await dns.promises.lookup('example.com').then(()=>true,()=>false);
 for(const t of CFG.connectTargets)R.proxy[t]=await ask('CONNECT '+t+' HTTP/1.1\\r\\nHost: '+t+'\\r\\n\\r\\n');
 R.proxy['GET http://api.anthropic.com/']=await ask('GET http://api.anthropic.com/ HTTP/1.1\\r\\nHost: api.anthropic.com\\r\\n\\r\\n');
 try{R.claude=cp.execFileSync('claude',['--version'],{encoding:'utf8',timeout:60000}).trim()}catch(e){R.claude='error: '+e.message.slice(0,100)}
 console.log('PROBE '+JSON.stringify(R));
})();
`;

const home = os.homedir();
const hostPaths = ['.config', '.config/gh', '.config/.wrangler', '.ssh', '.npmrc', '.claude', '.gnupg', '.gitconfig', 'code', 'code/argus-build-template', '.cache/claude-tmp'].map((p) => path.join(home, p)).concat([ROOT]);
const connectTargets = ['api.anthropic.com:443', 'registry.npmjs.org:443', 'example.com:443', 'github.com:443', 'api.cloudflare.com:443', 'api.anthropic.com:80', '1.1.1.1:443', 'localhost:443', '127.0.0.1:443', '10.89.77.1:443'];

async function agentChecks() {
  const notes = [];
  const t = await start(job('agent', { note: (l) => notes.push(l) }), [
    'node',
    '-e',
    probeScript({
      hostPaths,
      writeDirs: ['/', '/usr', '/etc', '/opt', '/var', '/home', '/home/node', path.dirname(repo), repo, '/home/agent', ...TMPFS_DIRS],
      execDirs: [...TMPFS_DIRS],
      directTargets: ['1.1.1.1:443', '8.8.8.8:53', '192.168.1.1:80', `${BUILD_NETWORK.gateway}:22`, '169.254.169.254:80'],
      connectTargets,
      proxyHost: EGRESS_ADDRESS,
      proxyPort: EGRESS_PORT,
    }),
  ]);
  const out = await t.done;
  snapshotIds();
  const line = out.stdout.split('\n').find((l) => l.startsWith('PROBE '));
  if (!line) {
    report('HIGH2', 'the probe ran in the agent container', false, `exit ${out.code}; stderr: ${out.stderr.trim().slice(-300)}`);
    await t.run.stop();
    return;
  }
  const probe = JSON.parse(line.slice('PROBE '.length));
  const expect = {
    uid: process.getuid(),
    repo,
    home: '/home/agent',
    caps: DEFAULT_CAPS,
    allowedEnv: containerEnv('agent').map(([k]) => k),
    proxyAllowed: EGRESS_ALLOW,
  };
  for (const c of judgeProbe(probe, expect)) report(c.finding, c.name, c.ok, c.detail);
  report('HIGH2', 'the image runs the pinned claude without a token', probe.claude === `${CLAUDE_CODE_VERSION} (Claude Code)` || probe.claude.startsWith(CLAUDE_CODE_VERSION), probe.claude);
  const argvProblems = checkRunTokens(t.argv, { operatorHome: home, mountRoots: [scratch], image, checkCommand: false });
  report('HIGH2', 'the argv the agent container really ran with meets the dry-run policy', argvProblems.length === 0, argvProblems.join(' | ') || `${t.argv.length} args`);
  await t.run.stop(); // reads the sidecar's refusals into the notes
  report('HIGH2', 'refusals reach the Build log (argus-egress: denied ...)', notes.some((n) => /denied example\.com:443/.test(n)) && notes.some((n) => /denied 1\.1\.1\.1:443/.test(n)), `${notes.length} lines, e.g. ${notes[0] ?? 'none'}`);
}

async function installCheck() {
  const template = process.env.ARGUS_TEMPLATE_REPO || path.join(home, 'code', 'argus-build-template');
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].filter((f) => fs.existsSync(path.join(template, f)));
  if (!files.includes('pnpm-lock.yaml')) {
    console.log(`SKIP check "pnpm install of the template lockfile": no template with a pnpm-lock.yaml at ${template}`);
    return;
  }
  for (const f of files) fs.copyFileSync(path.join(template, f), path.join(installDir, f));
  // The role's own command (`pnpm install --frozen-lockfile`), unchanged: that is the thing under test.
  const j = job('install', { cwd: installDir, mounts: [installDir], home: installHome, timeoutMs: 8 * 60_000 });
  const run = await teardown.launch((signal) => sandbox.launch({ ...j, signal }));
  const child = spawn(run.command, run.args, { env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.resume();
  const killer = setTimeout(() => child.kill('SIGKILL'), j.timeoutMs);
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  clearTimeout(killer);
  snapshotIds();
  const installed = fs.existsSync(path.join(installDir, 'node_modules', '.bin'));
  report('HIGH2', 'pnpm install of the template lockfile succeeds in the install container, through the proxy only', code === 0 && installed, code === 0 ? 'exit 0, node_modules populated' : `exit ${code}: ${stderr.trim().slice(-300)}`);
  await run.stop();
}

async function bundleCheck() {
  const script = `
const os=require('os'),net=require('net');
const ifs=Object.keys(os.networkInterfaces());
net.connect({host:'${EGRESS_ADDRESS}',port:${EGRESS_PORT},timeout:3000}).on('connect',function(){console.log('B '+JSON.stringify({ifs,proxy:true,tok:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,path:process.env.PATH.split(':')[0]}));process.exit(0)}).on('error',function(){console.log('B '+JSON.stringify({ifs,proxy:false,tok:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,path:process.env.PATH.split(':')[0]}));process.exit(0)}).on('timeout',function(){console.log('B '+JSON.stringify({ifs,proxy:false,tok:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,path:process.env.PATH.split(':')[0]}));process.exit(0)});`;
  const t = await start(job('bundle', { cwd: workDir, mounts: [workDir], home: installHome, binDir }), ['node', '-e', script]);
  const out = await t.done;
  snapshotIds();
  const line = out.stdout.split('\n').find((l) => l.startsWith('B '));
  if (!line) return report('HIGH2', 'the bundle container has no network', false, `no output; exit ${out.code}: ${out.stderr.trim().slice(-200)}`);
  const b = JSON.parse(line.slice(2));
  const bad = [
    ...b.ifs.filter((i) => i !== 'lo').map((i) => `interface ${i}`),
    ...(b.proxy ? ['reached the egress proxy'] : []),
    ...(b.tok ? ['has the Build token'] : []),
    ...(b.path === binDir ? [] : [`PATH starts with ${b.path}`]),
  ];
  report('HIGH2', 'the bundle container has no network, no token, and the export bin first on PATH', bad.length === 0, bad.join('; ') || `interfaces: ${b.ifs.join(',')}`);
  await t.run.stop();
}

async function stopCheck() {
  const nonce = 7000 + Math.floor(Math.random() * 900);
  const durations = [String(nonce), String(nonce + 1000), String(nonce + 2000)];
  const t = await start(job('agent'), ['sh', '-c', `sleep ${durations[0]} & (sleep ${durations[1]} & sleep ${durations[2]}) & wait`]);
  const up = await until(() => hostSleeps(durations).length === 3, 30_000);
  if (!up) {
    t.child.kill('SIGKILL');
    await t.run.stop();
    return report('MED4', 'stop ends the container and every grandchild', false, `the three sleeps never appeared (saw ${hostSleeps(durations).length})`);
  }
  // The worker is gone before the container: SIGKILL of the podman client (our own child, by pid) leaves the container running.
  t.child.kill('SIGKILL');
  await t.done;
  await sleep(500);
  const survived = containerExists(t.name) && hostSleeps(durations).length === 3;
  const t0 = Date.now();
  await t.run.stop();
  const gone = await until(() => hostSleeps(durations).length === 0, 5000);
  const ended = !containerExists(t.name);
  const left = pm(['ps', '-a', '-q', '--filter', `label=argus.build=${BUILD_ID}`]).stdout.trim();
  snapshotIds();
  report('MED4', 'stop ends the container and every grandchild (even after the client was SIGKILLed)', survived && gone && ended && left === '', `client killed: container ${survived ? 'kept running' : 'NOT running'}; run.stop() took ${Date.now() - t0} ms; container ${ended ? 'gone' : 'STILL THERE'}; sleeps ${gone ? 'gone' : 'ALIVE'}; labelled leftovers: ${left || 'none'}`);
}

async function timeoutCheck() {
  const t = await start(job('bundle', { cwd: workDir, mounts: [workDir], home: installHome, binDir }), ['sleep', '600'], { detach: true, timeoutSec: 6 });
  const started = Date.now();
  const first = await t.done;
  const created = first.code === 0 && containerExists(t.name);
  snapshotIds();
  // No stop, no client: only conmon's --timeout can end it.
  const gone = created && (await until(() => !containerExists(t.name), 40_000));
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!gone) await t.run.stop();
  report('MED4', '--timeout ends a container the worker abandoned (no stop, no client)', Boolean(gone), gone ? `gone ${secs} s after start with --timeout=6` : `still present after ${secs} s`);
}

async function guarded(name, finding, fn) {
  try {
    await fn();
  } catch (err) {
    report(finding, name, false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The cleanup after every launched run was stopped (`Teardown.stop()` does that part): kill our podman clients, remove by ID whatever
 * the label still finds, delete the scratch dir. Reached only through `teardown.stop()`, so it runs once and every caller awaits it.
 */
async function finishCleanup() {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  snapshotIds();
  leftovers = pm(['ps', '-a', '-q', '--no-trunc', '--filter', `label=argus.build=${BUILD_ID}`]).stdout.split('\n').filter(Boolean);
  for (const id of leftovers) pm(['rm', '-f', id]); // by ID, only what our label finds
  fs.rmSync(scratch, { recursive: true, force: true });
}

// An interrupted run must not strand the sidecar: it holds the fixed address every real Build needs. A second signal waits for
// the cleanup already running (it never exits mid-cleanup), and no check can launch a container once the cleanup has started.
let interrupted;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => {
    interrupted ??= code;
    console.log(`FAIL verify:contain interrupted by ${sig}; cleaning up`);
    teardown.stop().then(
      () => process.exit(interrupted),
      () => process.exit(interrupted),
    );
  });
}

/** A crash (SIGKILL, power loss) before cleanup leaves containers labelled with a build id from this script's range and a dead owner: reap those, by ID. */
function reapDeadRuns() {
  let rows = [];
  try {
    rows = JSON.parse(pm(['ps', '-a', '--filter', 'label=argus.build', '--format', 'json']).stdout || '[]');
  } catch {
    return;
  }
  for (const row of rows) {
    const labels = row.Labels ?? {};
    const id = Number(labels['argus.build']);
    if (!(id >= 900_000 && id < 1_000_000) || typeof row.Id !== 'string') continue;
    if (ownerState(String(labels['argus.owner'] ?? '')) !== 'dead') continue;
    console.log(`reaping container ${row.Id.slice(0, 12)} left by an earlier interrupted verify:contain (build id ${id})`);
    pm(['rm', '-f', row.Id]);
  }
}

try {
  reapDeadRuns();
  await guarded('agent container probe', 'HIGH2', agentChecks);
  await guarded('install container', 'HIGH2', installCheck);
  await guarded('bundle container', 'HIGH2', bundleCheck);
  await guarded('stop kills grandchildren', 'MED4', stopCheck);
  await guarded('--timeout backstop', 'MED4', timeoutCheck);
} finally {
  await teardown.stop();
}
if (interrupted !== undefined) process.exit(interrupted);
const stillThere = pm(['ps', '-a', '-q', '--no-trunc', '--filter', `label=argus.build=${BUILD_ID}`]).stdout.split('\n').filter(Boolean);
report('HIGH2', 'every container this run started is gone', stillThere.length === 0 && leftovers.length === 0, `${seenIds.size} containers seen (${[...seenIds].map((i) => i.slice(0, 12)).join(', ')}); removed by cleanup: ${leftovers.length}; remaining: ${stillThere.length}`);

const ok = results.length > 0 && results.every(Boolean);
console.log(`${ok ? 'PASS' : 'FAIL'} verify:contain overall (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
