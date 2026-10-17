#!/usr/bin/env node
// Scheduler regression suite over the private replay fixtures.
//   node tools/harness/verify-scheduler.js [--baseline origin/main] [--fixtures a.json,b.json]
// Compares the WORKING-TREE index.html against a baseline git ref, plus invariants of
// partial regeneration (Mon–Wed). Prints ids and counts only — never names.
// Exit code 0 = all PASS, 1 = at least one FAIL.
const { silenceSchedulerNoise } = require('./engine');
const S = require('./sim');
silenceSchedulerNoise();

// Operational fields compared for "job outside the range was modified".
const OP_FIELDS = ['day', 'dateISO', 'propertyId', 'serviceTypeId', 'startTime', 'duration', 'manualEndTime',
  'cleanerTimeOverrides', 'cleanersRequired', 'cleanerIds', 'priority', 'type', 'source', 'status', 'fallbackUsed',
  'flexibleWindow', 'windowStartTime', 'windowEndTime', 'manualEdited', 'schedulerDecisionCode',
  'templateLockedFromSheet', 'rescueUsed'];
const canon = v => v === undefined ? 'u' : v === null ? 'n' : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => k + ':' + canon(v[k])).join(',') + '}' : typeof v + ':' + String(v);
const isProtected = (E, j) => E.isLockedTemplateJob(j) || j.manualEdited || j.rescueUsed ||
  j.schedulerDecisionCode === 'manual_edit' || j.schedulerDecisionCode === 'rescue_split';

const baseRef = S.argValue('--baseline', 'origin/main');
const curF = S.currentFactory(), baseF = S.baselineFactory(baseRef);
console.log(`Sotto test: ${S.currentLabel}  |  baseline: ${baseRef}`);
if (curF.missing.length) console.log(`(non presenti in questa versione: ${curF.missing.join(', ')})`);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); };

for (const fx of S.fixtureList()) {
  const START = S.loadFixture(fx.file).input;
  const P = S.makeSim(curF.buildEngine(START)), B = S.makeSim(baseF.buildEngine(START));
  const E = P.E;
  const clone = js => js.map(j => ({ ...j }));
  console.log(`\n################ ${fx.id} ################`);

  // (1) Full-week generation identical to baseline (regression guard; an intentional
  //     scheduling change makes this FAIL by design — then justify the diff).
  const fwP = P.regenerate(clone(START.jobs), 0, 6), fwB = B.regenerate(clone(START.jobs), 0, 6);
  const sp = S.signature(E, fwP.fin).split('\n'), sb = new Set(S.signature(B.E, fwB.fin).split('\n'));
  const nDiff = sp.filter(x => !sb.has(x)).length;
  check(nDiff === 0, `(1) full-week vs ${baseRef}: ${nDiff === 0 ? 'IDENTICAL' : nDiff + ' job differ'}`);

  // (2)(3) Regenerate Mon–Wed on top of the full-week plan.
  const D0 = S.workedDays(E, fwP.fin);
  const r = P.regenerate(clone(fwP.fin), 0, 2);
  const before = new Map(fwP.fin.filter(j => S.DAYS.indexOf(j.day) > 2).map(j => [j.id, j]));
  const after = new Map(r.fin.filter(j => S.DAYS.indexOf(j.day) > 2).map(j => [j.id, j]));
  let outOfRange = 0;
  for (const [id, b] of before) { const a = after.get(id); if (!a || OP_FIELDS.some(f => canon(b[f]) !== canon(a[f]))) outOfRange++; }
  const Dr = S.workedDays(E, r.fin);
  let newOffenders = 0, overNow = 0, overBase = 0;
  START.cleaners.forEach(c => {
    const cd = (Dr[c.id] || new Set()).size, bd = (D0[c.id] || new Set()).size, mx = E.getEffectiveMaxWorkedDays(c);
    if (cd > mx && cd > bd) newOffenders++;
    if (cd > mx) overNow++;
    if (bd > mx) overBase++;
  });
  const hard = S.hardConflicts(E, r.fin);
  check(outOfRange === 0, `(2) regen Mon-Wed: Thu-Sun modificati=${outOfRange}`);
  check(newOffenders === 0 && !r.blocked, `(2) nuovi max-days offender=${newOffenders}${r.blocked ? ' (app BLOCCHEREBBE)' : ''}`);
  check(hard === 0, `(2) conflitti reali=${hard} | gap ${JSON.stringify(S.gaps(E, r.fin))}`);
  check(overNow <= overBase, `(3) cleaner oltre max-days: full-week=${overBase} -> post-regen=${overNow}`);

  // (9) The scheduler's INTERNAL plan never touched out-of-range jobs.
  const inOOR = new Map(r.traceInput.filter(j => S.DAYS.indexOf(j.day) > 2).map(j => [j.id, S.idsKey(E, j)]));
  let internalMod = 0;
  r.schedulerJobs.filter(j => S.DAYS.indexOf(j.day) > 2).forEach(j => {
    const b = inOOR.get(j.id); if (b !== undefined && b !== S.idsKey(E, j)) internalMod++;
  });
  check(internalMod === 0, `(9) job fuori range modificati nel piano interno=${internalMod}`);

  // (5)(6) Unique jobs; protected jobs (locked/manual/rescue) unchanged.
  const uniq = new Set(r.fin.map(j => j.id)).size;
  check(uniq === r.fin.length, `(5) jobs=${r.fin.length} uniq=${uniq}`);
  const bAll = new Map(fwP.fin.map(j => [j.id, j]));
  let protChanged = 0;
  r.fin.forEach(a => { const b = bAll.get(a.id); if (b && isProtected(E, b) && S.idsKey(E, b) !== S.idsKey(E, a)) protChanged++; });
  check(protChanged === 0, `(6) locked/manual/rescue modificati=${protChanged}`);

  // (4) Generate -> Rigenera -> Rigenera converges.
  let st = clone(START.jobs); const runs = [];
  for (let k = 1; k <= 3; k++) {
    const o = P.regenerate(st, 0, 6).fin;
    runs.push({ a: o.filter(j => j.status === 'assigned').length, h: S.hardConflicts(E, o), u: new Set(o.map(j => j.id)).size });
    st = clone(o);
  }
  const conv = runs[1].a === runs[2].a && runs[1].u === runs[2].u && runs.every(x => x.h === 0);
  check(conv, `(4) Gen1->R2->R3: ${runs.map((x, i) => `r${i + 1}=${x.a}/h${x.h}/u${x.u}`).join(' ')}`);

  // (7) Replay of a captured Rigenera reproduces it exactly.
  const g1 = P.regenerate(clone(START.jobs), 0, 6), g2 = P.regenerate(clone(g1.fin), 0, 6);
  const fixture = {
    schemaVersion: 'cleanflow-replay-v2', meta: { capturedAt: 'harness', appVersion: '' },
    input: { weekOffset: 0, cleaners: START.cleaners, properties: START.properties, training: START.training,
      travelBuffers: START.travelBuffers, opSettings: START.opSettings, jobs: JSON.parse(JSON.stringify(g2.traceInput)),
      weekStartISO: START.weekStartISO, weekEndISO: START.weekEndISO, startDay: 'Mon', endDay: 'Sun' },
    expectedOutput: { jobs: JSON.parse(JSON.stringify(g2.fin)) },
  };
  const rep = E.runReplayFixture(fixture);
  const repOk = rep.ok && (rep.missingInActual.length + rep.extraInActual.length + rep.fieldDiffs.length + rep.duplicateIdCount) === 0;
  check(repOk, rep.ok
    ? `(7) replay: missing=${rep.missingInActual.length} extra=${rep.extraInActual.length} fieldDiffs=${rep.fieldDiffs.length} dup=${rep.duplicateIdCount}`
    : `(7) replay FALLITO fase=${rep.phase}: ${rep.error}`);
}

console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures ? 1 : 0);
