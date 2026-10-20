#!/usr/bin/env node
// Hostaway re-import merge (mergeHostawayImportJobs in index.html): a second import of the
// same week must keep the plan and change only what Hostaway changed.
// Synthetic data only (no fixtures needed).
//   node tools/harness/verify-hostaway-merge.js [path/to/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
const a = src.indexOf('// ── HOSTAWAY RE-IMPORT MERGE');
const b = src.indexOf('// ── END HOSTAWAY RE-IMPORT MERGE');
if (a < 0 || b < 0) { console.error('merge block not found in ' + file); process.exit(1); }
const t2mLine = (src.match(/^const t2m = .*$/m) || [])[0];
// Like the real calcJobStatus, never returns 'unassigned'.
const ctx = { calcJobStatus: j => ((j.cleanerIds || []).length >= (j.cleanersRequired || 1) ? 'assigned' : 'needs_review') };
vm.createContext(ctx);
vm.runInContext(t2mLine + '\n' + src.slice(a, b) + '\nthis.merge = mergeHostawayImportJobs;', ctx);
const merge = ctx.merge;

let fails = 0, n = 0;
const ok = (cond, msg) => { n++; if (cond) console.log('  PASS  ' + msg); else { fails++; console.log('  FAIL  ' + msg); } };
const clone = x => JSON.parse(JSON.stringify(x));
const hostawayKeyOf = j => j.propertyId;
const inWeek = iso => iso >= '2026-10-26' && iso <= '2026-11-01';
let idn = 0; const makeId = () => 'new' + (++idn);
const opts = { inWeek, importSource: 'hostaway_api', makeId };

// What the importer produces for a booking (flexible checkout / check-in).
const co = (date, prop, start, extra = {}) => ({ propertyId: prop, day: 'x', dateISO: date, displayName: prop.toUpperCase(), startTime: start, duration: 2,
  cleanersRequired: 1, cleanerIds: [], type: 'checkout', source: 'hostaway_api', serviceTypeId: 'CHECKOUT_COMPLETE', status: 'unassigned',
  note: `Hostaway checkout · Res ${date.replace(/-/g, '')}${prop.replace(/\D/g, '')}`, flexibleWindow: true, windowStartTime: start, windowEndTime: '16:00', guestCount: 2, guestAdults: 2,
  guestChildren: null, guestInfants: null, guestPets: null, ...extra });
const ci = (date, prop, extra = {}) => ({ ...co(date, prop, '11:00', extra), type: 'checkin', serviceTypeId: 'PREPARE_FOR_GUEST', note: 'Hostaway check-in clean · Res 2', windowEndTime: '15:00', ...extra });
// The plan after a first import + generation: ids, people, maybe a scheduler-chosen start.
const planned = (job, id, people, extra = {}) => ({ ...clone(job), id, cleanerIds: people, status: 'assigned', ...extra });

const rows = [co('2026-10-26', 'p1', '10:00'), co('2026-10-27', 'p2', '10:00'), ci('2026-10-28', 'p3')];
const plan = [
  planned(rows[0], 'a', ['c1'], { startTime: '11:00' }),       // scheduler moved it inside the window
  planned(rows[1], 'b', ['c2']),
  planned(rows[2], 'c', ['c3']),
  { id: 't', source: 'template', dateISO: '2026-10-26', propertyId: 'office', type: 'template', cleanerIds: ['c4'] },
  { ...planned(co('2026-10-19', 'p9', '10:00'), 'old', ['c5']) },  // previous week
];

console.log('#### merge Hostaway re-import');
{
  const r = merge(plan, clone(rows), opts);
  ok(!r.report.hasNews, '1 identical re-import → nothing new');
  ok(JSON.stringify(r.jobs) === JSON.stringify(plan), '1 plan unchanged byte for byte (people, scheduler start kept)');
}
{
  const r = merge(plan, [...clone(rows), co('2026-10-29', 'p4', '10:00')], opts);
  ok(r.report.added.length === 1 && r.report.added[0].cleanerIds.length === 0 && r.report.added[0].id === 'new1', '2 new booking → added once, unassigned, with a new id');
  ok(r.jobs.filter(j => ['a', 'b', 'c', 't', 'old'].includes(j.id)).every(j => JSON.stringify(j) === JSON.stringify(plan.find(p => p.id === j.id))), '2 existing duties untouched');
}
{
  const nr = clone(rows); nr[1].guestCount = 4; nr[1].guestAdults = 3; nr[1].guestChildren = 1;
  const r = merge(plan, nr, opts);
  const b = r.jobs.find(j => j.id === 'b');
  ok(r.report.guests.length === 1 && b.guestCount === 4 && b.guestChildren === 1, '3 guests changed → updated and reported');
  ok(b.cleanerIds[0] === 'c2' && b.startTime === '10:00' && r.report.timing.length === 0, '3 people and timing kept');
}
{
  const nr = clone(rows); nr[0].windowStartTime = '10:30'; nr[0].startTime = '10:30';
  const r = merge(plan, nr, opts);
  const j = r.jobs.find(x => x.id === 'a');
  ok(r.report.timing.length === 1 && j.windowStartTime === '10:30' && j.startTime === '11:00' && j.cleanerIds[0] === 'c1', '4 window changed, scheduled start still inside → window updated, start and people kept');
}
{
  const nr = clone(rows); nr[0].windowStartTime = '12:00'; nr[0].startTime = '12:00';
  const r = merge(plan, nr, opts);
  const j = r.jobs.find(x => x.id === 'a');
  ok(j.startTime === '12:00' && j.cleanerIds[0] === 'c1', '5 late checkout pushes the window past the scheduled start → start moved, people kept');
}
{
  const man = clone(plan); man[0].manualEdited = true; man[0].schedulerDecisionCode = 'manual_edit'; man[0].startTime = '13:00';
  const nr = clone(rows); nr[0].windowStartTime = '12:00'; nr[0].startTime = '12:00';
  const r = merge(man, nr, opts);
  const j = r.jobs.find(x => x.id === 'a');
  ok(r.report.keptManual.length === 1 && r.report.timing.length === 0 && j.startTime === '13:00' && j.windowStartTime === '10:00', '6 manual duty → Hostaway change reported, manual timing kept');
}
{
  const res = clone(plan); res[1].rescueUsed = true; res[1].schedulerDecisionCode = 'rescue_split';
  const nr = clone(rows); nr[1].windowEndTime = '14:00';
  const r = merge(res, nr, opts);
  ok(r.report.keptManual.length === 1 && r.jobs.find(x => x.id === 'b').windowEndTime === '16:00', '7 rescue duty protected like a manual one');
}
{
  const nr = clone(rows); Object.assign(nr[1], { serviceTypeId: 'BACK_TO_BACK', windowEndTime: '15:00', constraintStartTime: '10:00', constraintEndTime: '15:00', incomingGuestCount: 3 });
  const r = merge(plan, nr, opts);
  const j = r.jobs.find(x => x.id === 'b');
  ok(j.serviceTypeId === 'BACK_TO_BACK' && j.constraintEndTime === '15:00' && j.cleanerIds[0] === 'c2' && r.report.timing.length === 1, '8 checkout becomes back-to-back → service + window updated, people kept');
}
{
  const r = merge(plan, [clone(rows[0]), clone(rows[2])], opts);
  ok(r.report.missing.length === 1 && r.report.missing[0].job.id === 'b' && r.report.missing[0].reason === 'gone' && r.jobs.some(j => j.id === 'b'), '9 cancelled booking → reported, NOT removed');
}
{
  // Reloaded plan: the backend does not keep the back-to-back constraint fields.
  const b2bRow = co('2026-10-30', 'p5', '10:00', { serviceTypeId: 'BACK_TO_BACK', constraintStartTime: '10:00', constraintEndTime: '15:00', windowEndTime: '15:00' });
  const reloaded = [...clone(plan), planned(b2bRow, 'e', ['c6'])]; delete reloaded[5].constraintStartTime; delete reloaded[5].constraintEndTime;
  const r = merge(reloaded, [...clone(rows), clone(b2bRow)], opts);
  ok(!r.report.hasNews && r.jobs.find(j => j.id === 'e').constraintEndTime === '15:00', '10 after a reload the lost constraint fields come back silently (still "nothing new")');
}
{
  const fb = clone(plan); Object.assign(fb[1], { fallbackUsed: true, fallbackOriginalDuration: 2, duration: 1.5, cleanersRequired: 1 });
  const r = merge(fb, clone(rows), opts);
  ok(!r.report.hasNews && r.jobs.find(j => j.id === 'b').duration === 1.5, '11 scheduler fallback (shorter duration) is not seen as a Hostaway change');
}
{
  const dup = [...clone(plan), planned(rows[1], 'b2', ['c7'])];
  const r = merge(dup, clone(rows), opts);
  ok(r.report.missing.length === 1 && r.report.unchanged === 3 && r.jobs.length === dup.length, '12 two planned duties but one booking: one-to-one, the extra is reported (not removed)');
}
{
  const edited = clone(plan); edited[1].note = 'Chiavi nella cassetta 3';
  const nr = clone(rows); nr[1].note = 'Hostaway checkout · Res 1 · Booking.com';
  const r = merge(edited, nr, opts);
  ok(r.jobs.find(j => j.id === 'b').note === 'Chiavi nella cassetta 3', '13 a supervisor note is never overwritten by the Hostaway note');
}
{
  const csvOpts = { ...opts, importSource: 'hostaway_csv' };
  const csvRow = { propertyId: 'p7', day: 'x', dateISO: '2026-10-31', startTime: '10:00', note: 'Hostaway checkout 31/10', type: 'checkout', source: 'hostaway_csv', serviceTypeId: 'CHECKOUT_COMPLETE', status: 'unassigned', cleanerIds: [] };
  const csvPlan = [planned(csvRow, 'k', ['c8'])];
  const r1 = merge(csvPlan, [clone(csvRow)], csvOpts);
  const r2 = merge(csvPlan, [{ ...clone(csvRow), startTime: '11:00' }], csvOpts);
  ok(!r1.report.hasNews && r2.report.timing.length === 1 && r2.jobs[0].startTime === '11:00' && r2.jobs[0].cleanerIds[0] === 'c8', '14 CSV (fixed start): same → nothing new; new time → updated, people kept');
}
{
  const r = merge(plan, clone(rows), opts);
  ok(r.jobs.find(j => j.id === 'old').cleanerIds[0] === 'c5' && r.jobs.find(j => j.id === 't').cleanerIds[0] === 'c4', '15 other weeks and template duties never touched');
}

console.log('#### review findings (2026-10-20)');
{
  // Two listings mapped to the same property: same key, different data.
  const x = co('2026-10-27', 'p8', '10:00', { guestCount: 2 }), y = co('2026-10-27', 'p8', '11:00', { guestCount: 5, windowStartTime: '11:00' });
  const dupPlan = [planned(x, 'x', ['c1']), planned(y, 'y', ['c2'])];
  const r = merge(dupPlan, [clone(x), clone(y)], opts);
  const rx = r.jobs.find(j => j.id === 'x'), ry = r.jobs.find(j => j.id === 'y');
  ok(!r.report.hasNews && rx.guestCount === 2 && ry.guestCount === 5 && ry.windowStartTime === '11:00', 'M1 same key, different bookings: identical re-import keeps each duty its own data');
  const r2 = merge(dupPlan, [clone(y), clone(x)], opts);
  ok(!r2.report.hasNews, 'M1 same, with the rows in the other order');
}
{
  const r = merge(plan, [...clone(rows), co('2026-11-02', 'p1', '10:00')], opts);
  ok(!r.report.hasNews && r.jobs.length === plan.length, 'M2 rows of another week are left to the caller (no duplicate, nothing reported)');
}
{
  const man = clone(plan); Object.assign(man[1], { manualEdited: true, schedulerDecisionCode: 'manual_edit', note: 'Hostaway checkout · Res 1 · chiavi in cassetta 3', displayName: 'Nome scelto a mano' });
  const nr = clone(rows); nr[1].displayName = 'NUOVO NOME';
  const r = merge(man, nr, opts);
  const j = r.jobs.find(x => x.id === 'b');
  ok(!r.report.hasNews && j.note === 'Hostaway checkout · Res 1 · chiavi in cassetta 3' && j.displayName === 'Nome scelto a mano', 'M3/m4 note and name are never refreshed silently (manual duty)');
  const r2 = merge(plan, nr, opts);
  ok(!r2.report.hasNews && r2.jobs.find(x => x.id === 'b').displayName === plan[1].displayName, 'm4 a renamed listing alone is not a change (nothing to publish after "nothing new")');
}
{
  const t = co('2026-10-27', 'p6', '10:00', { note: 'Hostaway checkout · Res 777 · Test' });
  const moved = planned({ ...t, dateISO: '2026-10-28', day: 'Mercoledì' }, 'mv', ['c9'], { manualEdited: true, schedulerDecisionCode: 'manual_edit' });
  const r = merge([...clone(plan), moved], [...clone(rows), clone(t)], opts);
  ok(!r.report.hasNews && r.jobs.filter(j => hostawayKeyOf(j) === 'p6').length === 1 && r.jobs.find(j => j.id === 'mv').dateISO === '2026-10-28', 'm1 duty moved by hand to another day: recognised by booking number, no duplicate, not "missing"');
}
{
  const un = clone(plan); un[1].cleanerIds = []; un[1].status = 'unassigned';
  const nr = clone(rows); nr[1].guestCount = 3; nr[1].windowEndTime = '15:30';
  const r = merge(un, nr, opts);
  ok(r.jobs.find(j => j.id === 'b').status === 'unassigned', 'm2 an unstaffed duty stays "unassigned" after an update');
}
{
  const ciPlan = [...clone(plan), planned(ci('2026-10-30', 'p3'), 'ci', ['c3'])];
  const r = merge(ciPlan, [...clone(rows), co('2026-10-30', 'p3', '10:00', { serviceTypeId: 'BACK_TO_BACK' })], opts);
  const m = r.report.missing.find(x => x.job.id === 'ci');
  ok(m && m.reason === 'b2b' && r.report.added.length === 1, 'm3 check-in replaced by a same-day back-to-back is explained as such');
}

console.log(fails ? `\n==== ${fails} FAIL (of ${n}) ====` : `\n==== ALL PASS (${n}) ====`);
process.exit(fails ? 1 : 0);
