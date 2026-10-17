// Shared harness plumbing: locations, fixtures, baseline engine from git, and a
// Node mirror of handleGenerate's partial-regeneration reconstruction.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createEngineFactory } = require('./engine');

const REPO = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO, 'index.html');
// PRIVATE data (guest/cleaner/property names): lives OUTSIDE the repo, never committed.
const FIXTURES_DIR = process.env.CLEANFLOW_FIXTURES || path.resolve(REPO, '..', 'CleanFlowFixtures');
// Canonical replay fixtures (weeks with known-good results). Override: --fixtures a.json,b.json
const DEFAULT_FIXTURES = [
  ['08-31', 'CleanFlow_Replay_2026-08-310.json'],
  ['09-07', 'CleanFlow_Replay_2026-09-070.json'],
  ['09-14', 'CleanFlow_Replay_2026-09-140.json'],
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function fixtureList() {
  const custom = argValue('--fixtures', null);
  const list = custom ? custom.split(',').map(f => [path.basename(f, '.json'), f]) : DEFAULT_FIXTURES;
  if (!fs.existsSync(FIXTURES_DIR)) {
    throw new Error(`Fixture dir not found: ${FIXTURES_DIR} (set CLEANFLOW_FIXTURES)`);
  }
  return list.map(([id, f]) => ({ id, file: path.isAbsolute(f) ? f : path.join(FIXTURES_DIR, f) }));
}

const loadFixture = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// index.html at a git ref (default origin/main), written to a temp file.
function baselineIndexPath(ref) {
  const html = execFileSync('git', ['show', `${ref}:index.html`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  const p = path.join(os.tmpdir(), `cleanflow_baseline_${ref.replace(/[^\w.-]/g, '_')}.html`);
  fs.writeFileSync(p, html);
  return p;
}

// "Current" = working-tree index.html, or any git ref via --current <ref> (no checkout).
const CURRENT_REF = argValue('--current', null);
const currentLabel = CURRENT_REF ? `${CURRENT_REF}:index.html` : 'working tree index.html';
const currentFactory = opts => createEngineFactory(CURRENT_REF ? baselineIndexPath(CURRENT_REF) : INDEX, opts);
const baselineFactory = ref => createEngineFactory(baselineIndexPath(ref));

// Mirror of handleGenerate (index.html): keepBefore/keepAfter passthrough, locked
// templates preserved, in-range jobs normalized ("prepared") then scheduled, final
// reconstruction, fairness, then the max-worked-days barrier when the version has it.
// `blocked` = the app would refuse this generation and keep the current shifts.
function makeSim(E) {
  const isFully = j => E.dedupeCleanerIds(j.cleanerIds || []).length >= E.getJobRequiredCleaners(j);
  function regenerate(state, startIdx, endIdx, weekOffset = 0) {
    const dayIdx = j => DAYS.indexOf(j.day);
    const keepBefore = state.filter(j => dayIdx(j) < startIdx);
    const keepAfter = state.filter(j => dayIdx(j) > endIdx);
    const regen = state.filter(j => dayIdx(j) >= startIdx && dayIdx(j) <= endIdx);
    const locked = regen.filter(j => E.isLockedTemplateJob(j));
    const prepared = regen.filter(j => !E.isLockedTemplateJob(j)).map(j => {
      const a = E.dedupeCleanerIds(j.cleanerIds || []).length, r = E.getJobRequiredCleaners(j);
      if (a === 0) return { ...j, cleanerIds: [], status: 'unassigned' };
      if (a < r) return { ...j, status: 'needs_review' };
      return { ...j, status: 'assigned' };
    });
    const traceInput = [...keepBefore, ...locked, ...prepared, ...keepAfter];
    const modifiableDays = new Set(DAYS.slice(startIdx, endIdx + 1));
    const res = E.runAutoSchedule(traceInput, weekOffset, { modifiableDays });
    let fin = [
      ...keepBefore,
      ...locked.map(j => ({ ...j, status: isFully(j) ? 'assigned' : 'needs_review' })),
      ...res.jobs.filter(j => dayIdx(j) >= startIdx && dayIdx(j) <= endIdx &&
        !(j.type === 'template' && locked.some(l => l.id === j.id))),
      ...keepAfter,
    ];
    fin = E.applyFairnessRebalance(fin, weekOffset, modifiableDays);
    const offenders = E.newMaxDaysOffenders ? E.newMaxDaysOffenders(state, fin) : [];
    return { fin, traceInput, schedulerJobs: res.jobs, modifiableDays, blocked: offenders.length > 0, offenders };
  }
  return { E, isFully, regenerate };
}

// Small read-only metrics over a plan.
const idsKey = (E, j) => E.dedupeCleanerIds(j.cleanerIds || []).slice().sort().join(',');
const signature = (E, jobs) => jobs.map(j => `${j.id}|${j.status}|${idsKey(E, j)}`).sort().join('\n');
const hardConflicts = (E, jobs) => E.getRealConflictCount(jobs, E.detectConflicts(jobs));
function workedDays(E, jobs) {
  const m = {};
  jobs.forEach(j => E.dedupeCleanerIds(j.cleanerIds || []).forEach(id => { (m[id] = m[id] || new Set()).add(j.day); }));
  return m;
}
function gaps(E, jobs) {
  let staff = 0, gender = 0, senior = 0;
  jobs.forEach(j => {
    if (!E.isMeaningfulJob(j)) return;
    const ids = E.dedupeCleanerIds(j.cleanerIds || []);
    if (ids.length < E.getJobRequiredCleaners(j)) staff++;
    if (!E.isLockedTemplateJob(j) && !E.genderRequirementMet(j, ids)) gender++;
    if (!E.isLockedTemplateJob(j) && !E.seniorRequirementMet(j, ids)) senior++;
  });
  return { staff, gender, senior };
}

module.exports = {
  REPO, INDEX, FIXTURES_DIR, DAYS, argValue, fixtureList, loadFixture,
  currentFactory, currentLabel, baselineFactory, makeSim, idsKey, signature, hardConflicts, workedDays, gaps,
};
