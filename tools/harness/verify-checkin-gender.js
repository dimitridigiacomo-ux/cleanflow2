#!/usr/bin/env node
// Check-in without a gender requirement (owner decision 2026-10-31): when the Properties
// sheet sets CheckinCleanersRequired BELOW RequiredMale + RequiredFemale, the check-in
// ("Prepare for guest") takes that many people of any gender; checkouts and back-to-backs
// keep the split. Part A uses synthetic sheet rows; part B runs the real scheduler on the
// first replay fixture (private data stays in memory: only ids and counts are printed).
//   node tools/harness/verify-checkin-gender.js [--current <ref>] [--fixtures a.json]
'use strict';
const S = require('./sim');
const { silenceSchedulerNoise } = require('./engine');
silenceSchedulerNoise();

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (cond) console.log('  PASS  ' + msg); else { fails++; console.log('  FAIL  ' + msg); } };
const factory = S.currentFactory({ seeds: ['parsePropertiesCSV', 'getGenderRequirementIssue'] });
console.log(`current = ${S.currentLabel}`);
if (factory.missing.length) { console.log('missing in index.html: ' + factory.missing.join(', ')); process.exit(1); }

// ── A. Parser + per-job requirement (synthetic) ──────────────────────────────
console.log('#### A. foglio Properties sintetico');
const HEAD = ['ID', 'Name', 'Type', 'Checkout Cleaners Required', 'Checkin Cleaners Required',
  'RequiredMaleCleaners', 'RequiredFemaleCleaners'];
const sheet = [
  ['Properties'], HEAD,
  ['p901', 'Free', 'Apartment', '2', '1', '1', '1'],   // check-in 1 < 1M+1F → gender-free check-in
  ['p902', 'Equal', 'Apartment', '2', '2', '1', '1'],    // check-in = split → unchanged
  ['p903', 'Blank', 'Apartment', '2', '', '1', '1'],  // no check-in value → inherits checkout (2)
  ['p904', 'None', 'Apartment', '1', '1', '0', '0'],   // no gender requirement at all
];
const props = factory.buildEngine({ cleaners: [], properties: [], training: [], travelBuffers: [], opSettings: {},
  weekStartISO: '2026-11-02', weekOffset: 0 }).parsePropertiesCSV(sheet);
const P = id => props.find(p => p.id === id);
ok(P('p901') && P('p901').checkinGenderFree === true && P('p901').checkinCleanersRequired === 1,
  'pFree: checkinGenderFree, check-in 1 persona');
ok(!(P('p901').parserWarnings || []).some(w => /CheckinCleanersRequired/.test(w)), 'pFree: nessun avviso rosso');
ok(P('p902').checkinGenderFree === false && P('p902').checkinCleanersRequired === 2, 'pEq: invariato (2, con genere)');
ok(P('p903').checkinGenderFree === false && P('p903').checkinCleanersRequired === 2, 'pBlank: eredita il checkout (2, con genere)');
ok(P('p904').checkinGenderFree === false, 'pNone: nessuna eccezione');

const E = factory.buildEngine({ cleaners: [{ id: 'm1', gender: 'm' }, { id: 'f1', gender: 'f' }], properties: props,
  training: [], travelBuffers: [], opSettings: {}, weekStartISO: '2026-11-02', weekOffset: 0 });
const job = (prop, type, st, extra = {}) => ({ id: prop + type + st, propertyId: prop, type, serviceTypeId: st, day: 'Mon',
  dateISO: '2026-11-02', startTime: '11:00', duration: 1, cleanerIds: [], source: 'hostaway_api', ...extra });
const ciFree = job('p901', 'checkin', 'PREPARE_FOR_GUEST');
const coFree = job('p901', 'checkout', 'CHECKOUT_COMPLETE');
const b2bFree = job('p901', 'checkout', 'BACK_TO_BACK');
const ciEq = job('p902', 'checkin', 'PREPARE_FOR_GUEST');
const g = j => { const r = E.getJobGenderRequirement(j); return `${r.male}M+${r.female}F`; };
ok(g(ciFree) === '0M+0F' && E.getJobRequiredCleaners(ciFree) === 1, `pFree check-in: ${g(ciFree)}, ${E.getJobRequiredCleaners(ciFree)} persona`);
ok(g(coFree) === '1M+1F' && E.getJobRequiredCleaners(coFree) === 2, `pFree checkout: ${g(coFree)}, ${E.getJobRequiredCleaners(coFree)} persone`);
ok(g(b2bFree) === '1M+1F', `pFree back-to-back: ${g(b2bFree)}`);
ok(g(ciEq) === '1M+1F' && E.getJobRequiredCleaners(ciEq) === 2, `pEq check-in: ${g(ciEq)}, ${E.getJobRequiredCleaners(ciEq)} persone`);
ok(E.genderRequirementMet(ciFree, ['m1']) && E.genderRequirementMet(ciFree, ['f1']), 'pFree check-in: un uomo da solo o una donna da sola va bene');
ok(!E.genderRequirementMet(coFree, ['m1']) && E.genderRequirementMet(coFree, ['m1', 'f1']), 'pFree checkout: serve ancora uomo + donna');
ok(E.getGenderRequirementIssue(ciFree, ['m1']) === null, 'pFree check-in: nessun problema di genere segnalato');
const st1 = E.calcJobStatus({ ...ciFree, cleanerIds: ['m1'] });
ok(st1 === 'assigned', `pFree check-in con 1 persona: status=${st1}`);
// A check-in imported before the rule carries the old raised count (2); a manual edit
// (Tabella) must not bring it back. On a property without the exception nothing changes.
const oldCi = { ...ciFree, cleanersRequired: 2, manualEdited: true, schedulerDecisionCode: 'manual_edit' };
ok(E.getJobRequiredCleaners(oldCi) === 1, `pFree check-in vecchio (2 salvato) modificato a mano: ${E.getJobRequiredCleaners(oldCi)} persona`);
const manEq = { ...ciEq, cleanersRequired: 3, manualEdited: true, schedulerDecisionCode: 'manual_edit' };
ok(E.getJobRequiredCleaners(manEq) === 3, `pEq check-in modificato a mano con 3 salvato: ${E.getJobRequiredCleaners(manEq)} (come prima)`);

// ── B. Real scheduler on a replay fixture ────────────────────────────────────
console.log('#### B. scheduler vero su fixture');
const fx = S.fixtureList()[0];
const START = S.loadFixture(fx.file).input;
// The first property with a 2-person gender split (1M+1F or more) becomes gender-free on check-in.
const target = START.properties.find(p => (Number(p.requiredMaleCleaners) || 0) >= 1 && (Number(p.requiredFemaleCleaners) || 0) >= 1);
if (!target) { ok(false, 'nessuna proprietà con uomo + donna nella fixture'); }
else {
  const run = free => {
    const properties = START.properties.map(p => p.id !== target.id ? p
      : { ...p, checkinGenderFree: free, checkinCleanersRequired: free ? 1 : Math.max(2, Number(p.checkinCleanersRequired) || 0) });
    const E2 = factory.buildEngine({ ...START, properties });
    const ci = { id: 'cf-test-ci', propertyId: target.id, type: 'checkin', serviceTypeId: 'PREPARE_FOR_GUEST', day: 'Mon',
      dateISO: START.weekStartISO, startTime: '11:00', duration: 1, cleanerIds: [], cleanersRequired: free ? 1 : 2,
      source: 'hostaway_api', status: 'unassigned', flexibleWindow: true, windowStartTime: '11:00', windowEndTime: '15:00' };
    const res = E2.runAutoSchedule([...JSON.parse(JSON.stringify(START.jobs)), ci], START.weekOffset || 0, { modifiableDays: new Set(['Mon']) });
    const out = res.jobs.find(j => j.id === ci.id);
    return { E2, out, jobs: res.jobs };
  };
  const free = run(true);
  const ids = free.E2.dedupeCleanerIds(free.out.cleanerIds || []);
  ok(ids.length === 1, `${fx.id} prop ${target.id}: check-in assegnato a ${ids.length} persona`);
  ok(free.E2.getGenderRequirementIssue(free.out, ids) === null && free.out.status === 'assigned', `check-in: status=${free.out.status}, nessun vincolo di genere`);
  const coSame = free.jobs.filter(j => j.propertyId === target.id && j.type !== 'checkin' && j.serviceTypeId !== 'PREPARE_FOR_GUEST' && j.id !== 'cf-test-ci');
  ok(coSame.every(j => { const r = free.E2.getJobGenderRequirement(j); return r.male + r.female >= 2; }),
    `stessa proprietà, ${coSame.length} turni non check-in: vincolo uomo + donna invariato`);
  const strict = run(false);
  const r = strict.E2.getJobGenderRequirement(strict.out);
  ok(r.male >= 1 && r.female >= 1 && strict.E2.getJobRequiredCleaners(strict.out) >= 2, `controllo senza eccezione: check-in ${r.male}M+${r.female}F, ${strict.E2.getJobRequiredCleaners(strict.out)} persone`);
}

console.log(fails ? `\n==== ${fails} FAIL / ${n} ====` : `\n==== ALL PASS (${n}) ====`);
process.exit(fails ? 1 : 0);
