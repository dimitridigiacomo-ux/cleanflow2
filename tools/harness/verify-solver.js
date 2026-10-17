#!/usr/bin/env node
// Local solver + max-worked-days barrier suite (working-tree index.html).
//   node tools/harness/verify-solver.js [--fixtures a.json,b.json]
// Exit code 0 = all PASS (SKIP does not fail), 1 = at least one FAIL.
const { silenceSchedulerNoise } = require('./engine');
const S = require('./sim');
silenceSchedulerNoise();

let failures = 0;
const check = (ok, label) => { if (!ok) failures++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); };
const curF = S.currentFactory();
console.log(`Sotto test: ${S.currentLabel}`);
const need = ['newMaxDaysOffenders', 'workedDaysByCleanerFinal', 'buildLocalAssignmentOptions', 'runReplayFixture'];
const absent = need.filter(n => !curF.exported.includes(n));
if (absent.length) { console.log(`SKIP: questo index.html non ha ${absent.join(', ')}`); process.exit(0); }
const fixtures = S.fixtureList();
const clone = js => js.map(j => ({ ...j }));
const rejectedForMaxDays = (opt, id) => (opt.rejected || []).some(r => r.cleanerId === id && /giorni lavorativi/.test(r.reason || ''));

// ── (8) Real plans: the assisted solver never recommends a NEW max-days overrun ──
for (const fx of fixtures) {
  const START = S.loadFixture(fx.file).input;
  const sim = S.makeSim(curF.buildEngine(START)), E = sim.E;
  const plan = sim.regenerate(clone(START.jobs), 0, 6).fin;
  const days = id => new Set(plan.filter(j => E.dedupeCleanerIds(j.cleanerIds || []).includes(id)).map(j => j.day));
  console.log(`\n#### solver · ${fx.id}`);
  let tested = 0, bad = 0;
  plan.filter(j => E.isMeaningfulJob(j) && E.dedupeCleanerIds(j.cleanerIds || []).length < E.getJobRequiredCleaners(j)).forEach(job => {
    let opt; try { opt = E.buildLocalAssignmentOptions(job, plan, 0); } catch (e) { return; }
    if (!opt || !opt.recommended) return;
    tested++;
    const cand = plan.map(j => j.id === opt.recommended.action.jobId ? { ...j, cleanerIds: opt.recommended.action.cleanerIds } : j);
    if (E.newMaxDaysOffenders(plan, cand).length) bad++;
  });
  check(bad === 0, `(8a) recommended testati=${tested}, che creano un nuovo superamento=${bad}`);

  const atMax = START.cleaners.find(c => E.isCleanerAutoSchedulable(c) && E.getEffectiveMaxWorkedDays(c) > 0 &&
    days(c.id).size === E.getEffectiveMaxWorkedDays(c) && (c.days || []).some(d => !days(c.id).has(d)));
  if (!atMax) { console.log('  SKIP  (8b/8c) nessuna cleaner esattamente al massimo con un giorno libero'); continue; }
  const newDay = atMax.days.find(d => !days(atMax.id).has(d));
  let job = plan.find(j => j.day === newDay && j.type === 'checkout' && E.getJobRequiredCleaners(j) === 1 && !E.isLockedTemplateJob(j));
  const synth = !job;
  if (synth) job = { id: 'SYNTH', day: newDay, type: 'checkout', propertyId: (plan.find(j => j.type === 'checkout') || {}).propertyId,
    startTime: '10:00', duration: 2, cleanersRequired: 1, cleanerIds: [], status: 'unassigned', source: 'hostaway_api', serviceTypeId: 'CHECKOUT_COMPLETE' };
  const opt = E.buildLocalAssignmentOptions(job, synth ? plan.concat([job]) : plan, 0);
  const isRec = !!(opt.recommended && opt.recommended.cleanerId === atMax.id);
  check(!isRec, `(8b) ${atMax.id} a ${days(atMax.id).size}/${E.getEffectiveMaxWorkedDays(atMax)} su nuovo giorno ${newDay}: recommended=${isRec ? 'SI' : 'no'}, in rejected(max-days)=${rejectedForMaxDays(opt, atMax.id) ? 'si' : 'no'}`);
  const tj = plan.find(j => j.day === newDay) || plan[0];
  const forced = plan.map(j => j.id === tj.id ? { ...j, cleanerIds: E.dedupeCleanerIds([...(j.cleanerIds || []), atMax.id]) } : j);
  check(E.newMaxDaysOffenders(plan, forced).length > 0, `(8c) azione forzata su ${tj.day}: la barriera la blocca`);
}

// ── Synthetic scenarios (built from the 09-14 fixture's shapes; ids only) ──
const RAW = S.loadFixture(fixtures[fixtures.length - 1].file);
const START = RAW.input;
const ALL_DAYS = S.DAYS;
const srcCleaner = START.cleaners.find(c => c.autoScheduleEnabled !== false) || START.cleaners[0];
const srcProp = START.properties.find(p => (START.training[srcCleaner.id] || []).includes(p.id)) || START.properties[0];
const svc = (START.jobs.find(j => j.type === 'checkout') || {}).serviceTypeId;
const cleanerWith = (id, max) => ({ ...srcCleaner, id, name: id.toUpperCase(), autoScheduleEnabled: true, maxWorkedDays: max,
  restDaysRequired: null, dailyHrs: 24, weeklyHrs: 200, days: [...ALL_DAYS] });
const pX = { ...srcProp, id: 'pX', name: 'PX' };
const lockedTemplate = (i, day, cid) => ({ id: 'L' + i, day, type: 'template', propertyId: 'pX', startTime: '10:00', duration: 2,
  cleanersRequired: 1, cleanerIds: [cid], status: 'assigned', flexibleWindow: false, serviceTypeId: svc });
const checkout = (id, day, status, ids, start = '10:00') => ({ id, day, type: 'checkout', propertyId: 'pX', startTime: start, duration: 2,
  cleanersRequired: 1, cleanerIds: ids, status, source: 'hostaway_api', serviceTypeId: svc });
const MON_SAT = ALL_DAYS.slice(0, 6);
const engineFor = (factory, cleaners) => factory.buildEngine({ ...START, cleaners, properties: [pX],
  training: Object.fromEntries(cleaners.map(c => [c.id, ['pX']])), travelBuffers: {} });

console.log('\n#### barriera max-worked-days');
// P1a — the REAL runReplayFixture on a candidate over the cap must fail with phase
// max_worked_days. Production gates never exceed the cap, so we inject a controlled
// regression: scheduler cap -> 999, while the barrier keeps the per-cleaner cap.
{
  let hits = 0;
  const regress = S.currentFactory({ transform: src => {
    let out = src.replace(/(const getEffectiveMaxWorkedDays = cleaner => \{)(\r?\n)/, (m, a, eol) => { hits++; return `${a}${eol}  return 999;${eol}`; });
    out = out.replace('mx=getEffectiveMaxWorkedDays(cl); if(cd>mx && cd>bd)', () => { hits++; return 'mx=(Number(cl?.maxWorkedDays)||6); if(cd>mx && cd>bd)'; });
    return out;
  } });
  if (hits !== 2) check(false, `(P1a) setup regressione fallito (sostituzioni=${hits}/2)`);
  else {
    const cX = cleanerWith('cX', 6);
    const jobs = [...MON_SAT.map((d, i) => lockedTemplate(i, d, 'cX')), checkout('SUN', 'Sun', 'unassigned', [])];
    const fixture = { schemaVersion: 'cleanflow-replay-v2', meta: { capturedAt: 'harness', appVersion: '' },
      input: { weekOffset: START.weekOffset || 0, weekStartISO: START.weekStartISO, weekEndISO: START.weekEndISO, startDay: 'Mon', endDay: 'Sun',
        cleaners: [cX], properties: [pX], training: { cX: ['pX'] }, travelBuffers: {}, opSettings: START.opSettings || {}, jobs },
      expectedOutput: { jobs } };
    const rep = engineFor(regress, [cX]).runReplayFixture(fixture);
    check(rep.ok === false && rep.phase === 'max_worked_days', `(P1a) replay con candidato oltre il cap -> ok=${rep.ok} fase=${rep.phase}`);
  }
}
// P1b — app baseline (needs_review) and replay baseline (prepared -> unassigned) flag
// the same offender, so both paths block and no status can diverge in an output.
{
  const cX = cleanerWith('cX', 6), E = engineFor(curF, [cX]);
  const six = () => MON_SAT.map((d, i) => lockedTemplate(i, d, 'cX'));
  const cand = [...six(), checkout('SUN', 'Sun', 'assigned', ['cX'])];
  const app = E.newMaxDaysOffenders([...six(), checkout('SUN', 'Sun', 'needs_review', [])], cand);
  const rep = E.newMaxDaysOffenders([...six(), checkout('SUN', 'Sun', 'unassigned', [])], cand);
  check(app.includes('cX') && rep.includes('cX'), '(P1b) baseline app e replay rilevano lo stesso offender (entrambe bloccano)');
}
// P1c — a normal real fixture replays without the barrier firing.
{
  const rep = curF.buildEngine(START).runReplayFixture(RAW);
  check(rep.ok === true && rep.phase === 'done', `(P1c) replay fixture reale -> ok=${rep.ok} fase=${rep.phase}`);
}

console.log('\n#### solver: diagnosi vs blocco');
{
  const c5 = cleanerWith('c5', 5), E = engineFor(curF, [c5]);
  const plan6 = extra => [...MON_SAT.map((d, i) => checkout('p' + i, d, 'assigned', ['c5'])), ...extra];
  const reasonOf = opt => ([opt.recommended, ...(opt.alternatives || [])].find(x => x && x.cleanerId === 'c5') || {}).reason || '';
  // P2a — pre-existing 6/5 + job on an already-worked day: allowed, honestly labelled.
  { const t = checkout('TGT', 'Mon', 'unassigned', [], '16:00'); const opt = E.buildLocalAssignmentOptions(t, plan6([t]), 0);
    const reason = reasonOf(opt);
    check(!rejectedForMaxDays(opt, 'c5'), '(P2a) 6/5 preesistente + giorno gia lavorato: non rifiutato');
    check(/Superamento già presente/.test(reason) && !/nessun superamento limiti/.test(reason), '(P2a) motivazione dichiara il superamento preesistente');
  }
  // P2b — pre-existing 6/5 + a NEW 7th day: rejected (worsens).
  { const t = checkout('TGT', 'Sun', 'unassigned', [], '15:00'); const opt = E.buildLocalAssignmentOptions(t, plan6([t]), 0);
    check(rejectedForMaxDays(opt, 'c5'), '(P2b) 6/5 preesistente + nuovo giorno: rifiutato');
  }
}

console.log('\n#### conteggio giorni');
{
  const E = curF.buildEngine(START);
  const m = E.workedDaysByCleanerFinal(['Mon', 'Mon', 'Tue', undefined, '', 'Funday'].map((day, i) => ({ id: 'j' + i, day, cleanerIds: ['z'] })));
  const d = [...(m.z || new Set())].sort();
  check(d.length === 2 && d[0] === 'Mon' && d[1] === 'Tue', `(V) solo giorni validi: ${JSON.stringify(d)}`);
}

console.log(`\n==== ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ====`);
process.exit(failures ? 1 : 0);
