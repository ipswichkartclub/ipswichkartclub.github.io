/**
 * Tests the diff engine that the admin page runs in the browser.
 *
 * buildDiff lives inside an IIFE in docs/assets/admin.js, so rather than
 * copying it (which would test a copy, not the shipped code) this pulls the
 * real function text out of the file and evaluates it against a stub `state`.
 */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../docs/assets/admin.js', import.meta.url), 'utf8');

/** Slice out a top-level `function name(...) { ... }` by brace matching. */
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('cannot find ' + name);
  let depth = 0, i = SRC.indexOf('{', start);
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const state = { detail: null };
// eslint-disable-next-line no-eval
const buildDiff = eval(`(${extract('buildDiff')})`);
globalThis.state = state;
globalThis.isMinorGuardian = eval(`(${extract('isMinorGuardian')})`);

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/** Shape a roster the way GET /api/admin/events/:id returns it. */
let nextId = 100;
function person(entrant, crn, guardian, entries, extra = {}) {
  return {
    personId: nextId++,
    entrant, crn, guardian,
    isMinor: guardian !== 'Not Applicable',
    email: '', mobile: '', homeClub: '',
    checkedIn: false, checkedInAt: null,
    entries: entries.map((e) => ({
      id: nextId++, kartNo: e.kartNo, class: e.class,
      transponder: e.transponder || '', kart: e.kart || '',
      engine: e.engine || '', memberType: e.memberType || '',
    })),
    ...extra,
  };
}
function row(kartNo, entrant, cls, crn, guardian, extra = {}) {
  return { kartNo, entrant, class: cls, crn, guardian,
    transponder: '', kart: '', engine: '', memberType: '',
    email: '', mobile: '', homeClub: '', ...extra };
}
const types = (d) => d.changes.map((c) => c.type).sort();

console.log('\n=== diff: no changes ===');
state.detail = { people: [
  person('Alice Adult', 'A1', 'Not Applicable', [{ kartNo: '1', class: 'DD2' }]),
  person('Ben Minor', 'B1', 'Parent P (900)', [{ kartNo: '2', class: 'Cadet 9' }]),
] };
let d = buildDiff([
  row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('2', 'Ben Minor', 'Cadet 9', 'B1', 'Parent P (900)'),
]);
check('identical file produces no changes', d.changes.length === 0, d.changes);
check('...and counts both as unchanged', d.same === 2, d.same);

console.log('\n=== diff: added driver ===');
d = buildDiff([
  row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('2', 'Ben Minor', 'Cadet 9', 'B1', 'Parent P (900)'),
  row('7', 'New Entry', 'X30', 'N1', 'Not Applicable'),
]);
check('one addition detected', types(d).join() === 'addPerson', types(d));
check('...carries the entry with it', d.changes[0].op.entries.length === 1, d.changes[0].op.entries);
check('...and the person payload', d.changes[0].op.person.crn === 'N1', d.changes[0].op.person);

console.log('\n=== diff: removed driver ===');
d = buildDiff([row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable')]);
check('one removal detected', types(d).join() === 'removePerson', types(d));
check('...naming the right driver', d.changes[0].label === 'Ben Minor', d.changes[0].label);

console.log('\n=== diff: changed kart number ===');
d = buildDiff([
  row('99', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('2', 'Ben Minor', 'Cadet 9', 'B1', 'Parent P (900)'),
]);
check('one entry update', types(d).join() === 'updateEntry', types(d));
check('...with only the changed field', JSON.stringify(d.changes[0].op.fields) === '{"kartNo":"99"}', d.changes[0].op.fields);
check('...showing was -> now', d.changes[0].fieldRows[0].was === '1' && d.changes[0].fieldRows[0].now === '99',
  d.changes[0].fieldRows);

console.log('\n=== diff: changed guardian (minor status) ===');
d = buildDiff([
  row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('2', 'Ben Minor', 'Cadet 9', 'B1', 'Other Parent (901)'),
]);
check('guardian change detected', types(d).join() === 'updatePerson', types(d));
check('...sends the new guardian', d.changes[0].op.fields.guardian === 'Other Parent (901)', d.changes[0].op.fields);

console.log('\n=== diff: driver gains a second class ===');
d = buildDiff([
  row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('5', 'Alice Adult', 'X30', 'A1', 'Not Applicable'),
  row('2', 'Ben Minor', 'Cadet 9', 'B1', 'Parent P (900)'),
]);
check('addEntry, not addPerson', types(d).join() === 'addEntry', types(d));
check('...attached to the existing driver', d.changes[0].op.personId === state.detail.people[0].personId);

console.log('\n=== diff: driver withdraws from one class ===');
state.detail = { people: [
  person('Multi Class', 'M1', 'Not Applicable', [
    { kartNo: '1', class: 'DD2' }, { kartNo: '5', class: 'X30' },
  ]),
] };
d = buildDiff([row('1', 'Multi Class', 'DD2', 'M1', 'Not Applicable')]);
check('removeEntry, not removePerson', types(d).join() === 'removeEntry', types(d));
check('...targets the X30 entry', d.changes[0].op.entryId === state.detail.people[0].entries[1].id);

console.log('\n=== diff: identity is CRN-first, name second ===');
// renamed in the new file but the same CRN -> an update, not remove+add
state.detail = { people: [person('Olde Name', 'C1', 'Not Applicable', [{ kartNo: '3', class: 'DD2' }])] };
d = buildDiff([row('3', 'New Name', 'DD2', 'C1', 'Not Applicable')]);
check('same CRN, new name => rename', types(d).join() === 'updatePerson', types(d));
check('...field is the name', d.changes[0].op.fields.entrant === 'New Name', d.changes[0].op.fields);

// gains a CRN it did not have before, matched on name
state.detail = { people: [person('No Crn Yet', '', 'Not Applicable', [{ kartNo: '4', class: 'DD2' }])] };
d = buildDiff([row('4', 'No Crn Yet', 'DD2', 'Z9', 'Not Applicable')]);
check('name match when the CRN is new => update', types(d).join() === 'updatePerson', types(d));
check('...sets the CRN', d.changes[0].op.fields.crn === 'Z9', d.changes[0].op.fields);

console.log('\n=== diff: checked-in drivers are flagged ===');
state.detail = { people: [
  person('Already In', 'K1', 'Not Applicable', [{ kartNo: '1', class: 'DD2' }], { checkedIn: true }),
] };
d = buildDiff([]);
check('removal of a checked-in driver is flagged', d.changes[0].checkedIn === true, d.changes[0]);
check('...and asks the server to confirm', d.changes[0].op.confirmCheckedIn === true, d.changes[0].op);

console.log('\n=== diff: blank and malformed rows are ignored ===');
state.detail = { people: [person('Alice Adult', 'A1', 'Not Applicable', [{ kartNo: '1', class: 'DD2' }])] };
d = buildDiff([
  row('1', 'Alice Adult', 'DD2', 'A1', 'Not Applicable'),
  row('', '', '', '', ''),
  { kartNo: '8', entrant: 'No Class', class: '', crn: 'X1', guardian: 'Not Applicable' },
]);
check('rows without entrant/class are skipped', d.changes.length === 0, d.changes);

console.log('\n=== diff: a realistic revision ===');
state.detail = { people: [
  person('Stays', 'S1', 'Not Applicable', [{ kartNo: '1', class: 'DD2' }]),
  person('Withdraws', 'W1', 'Not Applicable', [{ kartNo: '2', class: 'DD2' }]),
  person('Kart Change', 'KC', 'Not Applicable', [{ kartNo: '3', class: 'DD2' }]),
  person('Sibling One', 'SB1', 'Mum M (700)', [{ kartNo: '4', class: 'Cadet 9' }]),
] };
d = buildDiff([
  row('1', 'Stays', 'DD2', 'S1', 'Not Applicable'),
  row('33', 'Kart Change', 'DD2', 'KC', 'Not Applicable'),
  row('4', 'Sibling One', 'Cadet 9', 'SB1', 'Mum M (700)'),
  row('5', 'Sibling Two', 'Cadet 9', 'SB2', 'Mum M (700)'),
]);
check('1 add, 1 remove, 1 update', types(d).join() === 'addPerson,removePerson,updateEntry', types(d));
check('...one driver unchanged', d.same === 2, d.same);
const add = d.changes.find((c) => c.type === 'addPerson');
check('...the new sibling is a minor driver', add.isMinor === true, add);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
