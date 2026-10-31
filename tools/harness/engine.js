// Loads the REAL CleanFlow scheduler out of an index.html and evaluates it in Node,
// with the domain globals (CLEANERS, PROPERTIES, TRAINING, ...) bound to a fixture.
//
// How: brace-match every top-level `const|let|function` declaration, take the
// transitive closure from SEEDS, and eval that closure inside buildEngine(). Nothing
// in index.html is modified. Intentionally NOT in strict mode: the evaluated code is
// the browser source as-is, and the proven harness ran it sloppy.
const fs = require('fs');

// Functions/values the suites need. Names missing from a given index.html (e.g. an
// older baseline) are simply not exported — check `missing` before relying on them.
const SEEDS = [
  'runAutoSchedule', 'applyFairnessRebalance', 'fairnessRebalancePass', 'CLEANFLOW_FAIRNESS_PASS_ENABLED',
  'runReplayFixture', 'diffReplayJobs',
  'getJobRequiredCleaners', 'getWeekStartISO', 'getWeekEndISO',
  'detectConflicts', 'getRealConflictCount', 'isRealConflictIssue',
  'genderRequirementMet', 'seniorRequirementMet', 'getJobGenderRequirement', 'isSeniorCleaner',
  'dedupeCleanerIds', 'isLockedTemplateJob', 'calcJobStatus', 'isMeaningfulJob',
  'isMutableSchedulerJob', 'isSchedulerOwnedAssignment', 'isCleanerAutoSchedulable',
  'getEffectiveMaxWorkedDays', 'newMaxDaysOffenders', 'workedDaysByCleanerFinal',
  'buildLocalAssignmentOptions', 'getCleanerEffectiveJobDuration', 'buildConstraints', 'scoreOptPlan',
  'createDebugTraceCollector',
];
// Bound by buildEngine() or provided by the JS runtime — never pulled from the source.
const PROVIDED = new Set(['CLEANERS', 'PROPERTIES', 'TRAINING', 'TRAVEL_BUFFERS', 'OP_SETTINGS', '__CF_REPLAY_NOW',
  'console', 'Math', 'Object', 'Array', 'String', 'Number', 'JSON', 'Set', 'Map', 'Boolean', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'RegExp', 'undefined', 'NaN', 'Infinity', 'Intl', 'performance']);
// Browser/React-only identifiers: never follow references into UI code.
const BANNED = new Set(['useState', 'useRef', 'useEffect', 'useMemo', 'useCallback', 'document', 'window',
  'React', 'ReactDOM', 'createElement']);

// End offset of the declaration starting at `start` (string/comment aware).
function endOf(src, start) {
  let d = 0, seen = false, inS = null, inL = false, inB = false;
  const kind = /^\s*function\b/.test(src.slice(start, start + 20)) ? 'fn' : 'const';
  for (let j = start; j < src.length; j++) {
    const c = src[j], c2 = src[j + 1];
    if (inL) { if (c === '\n') inL = false; continue; }
    if (inB) { if (c === '*' && c2 === '/') { inB = false; j++; } continue; }
    if (inS) { if (c === '\\') { j++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && c2 === '/') { inL = true; j++; continue; }
    if (c === '/' && c2 === '*') { inB = true; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '(' || c === '{' || c === '[') { d++; if (c === '{') seen = true; }
    else if (c === ')' || c === '}' || c === ']') { d--; if (kind === 'fn' && seen && d === 0) return j + 1; }
    else if (c === ';' && d === 0 && kind === 'const') return j + 1;
  }
  return src.length;
}

// opts.transform(src) lets a test inject a controlled regression (see verify-solver.js).
// opts.seeds adds names to export beyond SEEDS (see verify-checkin-gender.js).
function createEngineFactory(htmlPath, opts = {}) {
  let src = fs.readFileSync(htmlPath, 'utf8');
  if (opts.transform) src = opts.transform(src);
  const decls = new Map();
  const declRe = /^(const|let|function)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = declRe.exec(src))) { if (!decls.has(m[2])) decls.set(m[2], src.slice(m.index, endOf(src, m.index))); }
  const refs = t => { const s = new Set(); const re = /[A-Za-z_$][\w$]*/g; let r; while ((r = re.exec(t))) s.add(r[0]); return s; };
  const seeds = [...SEEDS, ...(opts.seeds || [])];
  const inc = new Set(), stack = [...seeds];
  while (stack.length) {
    const n = stack.pop();
    if (inc.has(n) || PROVIDED.has(n)) continue;
    const d = decls.get(n);
    if (!d) continue;
    inc.add(n);
    for (const id of refs(d)) if (id !== n && !BANNED.has(id) && decls.has(id) && !inc.has(id)) stack.push(id);
  }
  const ordered = [...inc].map(n => ({ t: decls.get(n), i: src.indexOf(decls.get(n)) }))
    .sort((a, b) => a.i - b.i).map(x => x.t).join('\n\n');
  const exported = seeds.filter(n => inc.has(n));
  const missing = seeds.filter(n => !inc.has(n));

  function buildEngine(inp) {
    let CLEANERS = inp.cleaners, PROPERTIES = inp.properties, TRAINING = inp.training, TRAVEL_BUFFERS = inp.travelBuffers;
    const OP_SETTINGS = Object.assign({ defaultTravelBufferMinutes: 30 }, inp.opSettings || {});
    // Clock pin, same rule as runReplayFixture: anchor = weekStartISO − weekOffset×7 days.
    const [Y, Mo, Da] = inp.weekStartISO.split('-').map(Number);
    let __CF_REPLAY_NOW = new Date(Y, Mo - 1, Da);
    __CF_REPLAY_NOW.setDate(__CF_REPLAY_NOW.getDate() - (inp.weekOffset || 0) * 7);
    __CF_REPLAY_NOW.setHours(0, 0, 0, 0);
    const __E = {};
    eval(ordered + '\n;Object.assign(__E,{' + exported.join(',') + '});');
    return __E;
  }
  return { buildEngine, exported, missing, includedCount: inc.size };
}

// The scheduler logs per-job diagnostics ("[gender] ...", "[senior] ..."); keep runs readable.
function silenceSchedulerNoise() {
  console.debug = () => {};
  const log = console.log.bind(console);
  console.log = (...a) => { if (typeof a[0] === 'string' && /^\[(gender|senior)\]/.test(a[0])) return; log(...a); };
}

module.exports = { createEngineFactory, silenceSchedulerNoise, SEEDS };
