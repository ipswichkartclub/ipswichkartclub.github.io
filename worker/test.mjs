/* End-to-end test of the worker against a real node:sqlite D1 shim. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './src/index.js';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const ROWS = makeRows();

/**
 * Synthetic entry list with the same shape as a real IKC report:
 * 247 entries / 240 people, 14 classes, 7 drivers doubling up, and the same
 * mix of "Not Applicable" vs named guardians. No real member data in the repo.
 */
function makeRows() {
  const CLASSES = [
    ['Cadet 9', 28, true], ['Cadet 12', 33, true], ['KA3 Junior Light', 29, true],
    ['KA3 Junior Heavy', 23, true], ['KA2', 11, true], ['KA3 Senior', 21, false],
    ['TaG 125 Restricted Light', 23, false], ['TaG 125 Restricted Medium', 14, false],
    ['TaG 125 Restricted Masters', 23, false], ['TaG 125', 13, false], ['X30', 15, false],
    ['Cadet 9 - P', 5, true], ['Cadet 12 - P', 4, true], ['DD2', 5, false],
  ];
  const rows = [];
  let n = 0;
  let jn = 0;   // juniors are grouped into families of 3 sharing a guardian
  for (const [cls, count, junior] of CLASSES) {
    for (let i = 0; i < count; i++) {
      n++;
      const fam = junior ? Math.ceil(++jn / 3) : 0;
      rows.push({
        kartNo: String((i * 7) % 99 + 1),
        entrant: 'Driver ' + n,
        class: cls,
        transponder: String(1000000 + n),
        kart: 'Kart Republic-Mini (' + n + ')',
        engine: 'Vortex-MinRok (' + n + ')',
        guardian: junior ? 'Guardian ' + fam + ' (2026' + fam + ')' : 'Not Applicable',
        email: 'driver' + n + '@example.invalid',
        mobile: '04' + String(10000000 + n),
        memberType: junior ? 'Junior - C' : 'Senior - B',
        homeClub: 'Ipswich Kart Club Inc',
        crn: 'CRN' + String(100000 + n),
      });
    }
  }
  // 7 drivers entered in a second class, same CRN + name (as in the real file)
  const doubles = [
    ['KA3 Junior Light', 'KA2'], ['KA3 Junior Light', 'KA3 Junior Heavy'],
    ['KA3 Junior Light', 'KA3 Junior Heavy'], ['KA3 Senior', 'X30'],
    ['KA3 Senior', 'X30'], ['KA3 Senior', 'X30'], ['KA3 Senior', 'X30'],
  ];
  doubles.forEach(([from, to], i) => {
    const src = rows.filter((r) => r.class === from)[i];
    rows.push({ ...src, class: to, kartNo: String(50 + i), transponder: String(9000000 + i) });
  });
  return rows;
}

/* ---- minimal D1 shim over node:sqlite ---- */
class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _p() { return this.db.prepare(this.sql); }
  async first() { const r = this._p().get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this._p().all(...this.args) }; }
  async run() { const r = this._p().run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const db = new DatabaseSync(':memory:');
for (const stmt of SCHEMA.split(';')) { const s = stmt.trim(); if (s) db.exec(s); }

const ADMIN_KEY = 'test-admin-key-123';
const env = { DB: new D1(db), ADMIN_KEY, ALLOWED_ORIGINS: '*' };

const BASE = 'https://api.test';
function req(method, path, { body, key, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip, 'User-Agent': 'test' };
  if (body) headers['content-type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;
  return new Request(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
async function call(method, path, opts) {
  const res = await worker.fetch(req(method, path, opts), env);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

let pass = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { failCount++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('\n=== 1. auth ===');
let r = await call('GET', '/api/admin/events');
check('no key rejected', r.status === 401, r.body);
r = await call('GET', '/api/admin/events', { key: 'wrong-key-abcdefgh' });
check('wrong key rejected', r.status === 401, r.body);
r = await call('GET', '/api/admin/ping', { key: ADMIN_KEY });
check('correct key accepted', r.status === 200, r.body);

console.log('\n=== 2. create event from the real 247-row spreadsheet ===');
r = await call('POST', '/api/admin/events', {
  key: ADMIN_KEY,
  body: { name: 'Test Meeting', date: '2026-09-12', rows: ROWS },
});
check('created', r.status === 201, r.body);
const EV = r.body.event.id;
check('254 entries stored', r.body.entries === 254, r.body.entries);
check('247 unique people (7 doubled up)', r.body.people === 247, r.body.people);
console.log('       event id =', EV);

console.log('\n=== 3. public roster ===');
r = await call('GET', '/api/events/' + EV);
check('roster ok', r.status === 200);
const roster = r.body;
check('14 classes', roster.classes.length === 14, roster.classes.length);
check('254 entries', roster.entries.length === 254, roster.entries.length);
check('none checked in yet', roster.entries.every(e => !e.checkedIn));
const cadet9 = roster.entries.filter(e => e.class === 'Cadet 9');
check('Cadet 9 has 28', cadet9.length === 28, cadet9.length);
check('kart numbers sort numerically in class', (() => {
  const ks = cadet9.map(e => parseInt(e.kartNo, 10));
  return ks.every((v, i) => i === 0 || ks[i - 1] <= v);
})(), cadet9.map(e => e.kartNo).join(','));

// the first driver entered in two classes
const dupName = roster.entries.filter(e => e.class === 'KA3 Junior Light')[0].entrant;
const brodieEntries = roster.entries.filter(e => e.entrant === dupName);
check('doubled-up driver has 2 entries', brodieEntries.length === 2, brodieEntries.length);
check('...sharing one personId', brodieEntries[0].personId === brodieEntries[1].personId);
const BRODIE = brodieEntries[0].personId;

// junior flag
const charlotte = roster.entries.find(e => e.class === 'Cadet 9');
check('guardian driver flagged junior', charlotte.isJunior === true);
const adult = roster.entries.find(e => e.class === 'DD2');
check('"Not Applicable" guardian is not junior', adult.isJunior === false);
const ADAM = adult.personId;

console.log('\n=== 4. one check-in satisfies every class ===');
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: BRODIE, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-brodie' } });
check('checked in ok', r.body.status === 'ok', r.body);
check('response lists both entries', r.body.person.entries.length === 2, r.body.person.entries);
r = await call('GET', '/api/events/' + EV);
const brodieNow = r.body.entries.filter(e => e.personId === BRODIE);
check('both class entries now show checked in', brodieNow.every(e => e.checkedIn), brodieNow);
check('only 1 person counted', r.body.entries.filter(e => e.checkedIn).length === 2, 'entries flagged');

console.log('\n=== 4b. the public API never exposes guardian / CRN / contacts ===');
{
  const probe = JSON.stringify((await call('GET', '/api/events/' + EV)).body);
  check('roster has no guardian', !/guardian/i.test(probe));
  check('roster has no CRN', !/crn|CRN1000/i.test(probe));
  check('roster has no email or mobile', !/@example\.invalid|"mobile"/i.test(probe));

  const one = JSON.stringify((await call('POST', '/api/checkin', {
    body: { eventId: EV, personId: BRODIE, acknowledged: true, deviceId: 'dev-probe' },
  })).body);
  check('check-in response has no guardian', !/guardian/i.test(one), one.slice(0, 200));
  check('check-in response has no CRN', !/crn/i.test(one), one.slice(0, 200));
}

console.log('\n=== 5. same person again (different device) ===');
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: BRODIE, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-other' } });
check('already / person', r.body.status === 'already' && r.body.reason === 'person', r.body);

console.log('\n=== 6. adult device limit = 1 ===');
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: ADAM, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-adult' } });
check('first adult ok', r.body.status === 'ok', r.body);
const otherAdult = roster.entries.find(e => !e.isJunior && e.personId !== ADAM && e.personId !== BRODIE);
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: otherAdult.personId, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-adult' } });
check('second adult on same device blocked', r.body.status === 'already' && r.body.reason === 'device', r.body);
check('block names who used the device', r.body.previous[0].entrant === adult.entrant, r.body.previous);

console.log('\n=== 7. guardian device allowance = 2 (siblings) ===');
const juniors = roster.entries.filter(e => e.isJunior);
// group juniors into families by guardian (only the admin view exposes it)
const adminPeople = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY })).body.people;
const families = new Map();
adminPeople.filter(p => p.isJunior).forEach(p => {
  if (!families.has(p.guardian)) families.set(p.guardian, []);
  families.get(p.guardian).push(p.personId);
});
const bigFamilies = [...families.values()].filter(f => f.length >= 3);
check('fixture has families of 3+ siblings', bigFamilies.length >= 2, bigFamilies.length);

const fam1 = bigFamilies[0];
const checkIn = (pid, dev) => call('POST', '/api/checkin', {
  body: { eventId: EV, personId: pid, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: dev },
});
r = await checkIn(fam1[0], 'dev-parent');
check('junior 1 ok', r.body.status === 'ok', r.body);
r = await checkIn(fam1[1], 'dev-parent');
check('sibling 2 ok (second attempt allowed)', r.body.status === 'ok', r.body);
r = await checkIn(fam1[2], 'dev-parent');
check('sibling 3 blocked by the device limit', r.body.status === 'already' && r.body.reason === 'device', r.body);

console.log('\n=== 8. racing parent: 2 kids then themselves ===');
const fam2 = bigFamilies[1];
r = await checkIn(fam2[0], 'dev-racingparent');
check('kid 1 ok', r.body.status === 'ok', r.body);
r = await checkIn(fam2[1], 'dev-racingparent');
check('kid 2 ok', r.body.status === 'ok', r.body);
const parentAdult = roster.entries.find(e => !e.isJunior && ![ADAM, BRODIE, otherAdult.personId].includes(e.personId));
r = await checkIn(parentAdult.personId, 'dev-racingparent');
check('parent can still check THEMSELVES in (separate adult budget)', r.body.status === 'ok', r.body);
r = await checkIn(fam2[2], 'dev-racingparent');
check('but a 3rd kid is still blocked', r.body.status === 'already' && r.body.reason === 'device', r.body);
const otherAdult2 = roster.entries.find(e => !e.isJunior &&
  ![ADAM, BRODIE, otherAdult.personId, parentAdult.personId].includes(e.personId));
r = await checkIn(otherAdult2.personId, 'dev-racingparent');
check('and a 2nd adult is still blocked', r.body.status === 'already' && r.body.reason === 'device', r.body);

console.log('\n=== 8b. a device is bound to the first junior\'s guardian ===');
{
  // Build a dedicated event so the guardian shapes are exactly what we want.
  const G = (n) => `Parent ${n} (2026${n})`;
  const rows = [
    { kartNo: '1', entrant: 'Kid A1', class: 'Cadet 9', crn: 'A1', guardian: G(1) },
    { kartNo: '2', entrant: 'Kid A2', class: 'Cadet 9', crn: 'A2', guardian: G(1) },
    { kartNo: '3', entrant: 'Kid B1', class: 'Cadet 9', crn: 'B1', guardian: G(2) },
    // siblings listing the same two parents in the OPPOSITE order
    { kartNo: '4', entrant: 'Kid C1', class: 'Cadet 9', crn: 'C1', guardian: `${G(3)}, ${G(4)}` },
    { kartNo: '5', entrant: 'Kid C2', class: 'Cadet 9', crn: 'C2', guardian: `${G(4)}, ${G(3)}` },
    // one child lists both parents, the other lists only one of them
    { kartNo: '6', entrant: 'Kid D1', class: 'Cadet 9', crn: 'D1', guardian: `${G(5)}, ${G(6)}` },
    { kartNo: '7', entrant: 'Kid D2', class: 'Cadet 9', crn: 'D2', guardian: G(6) },
    { kartNo: '8', entrant: 'Grown Up', class: 'DD2', crn: 'E1', guardian: 'Not Applicable' },
  ];
  const made = await call('POST', '/api/admin/events', {
    key: ADMIN_KEY, body: { name: 'Guardian rules', rows },
  });
  const GEV = made.body.event.id;
  const ros = (await call('GET', '/api/events/' + GEV)).body.entries;
  const id = (name) => ros.find((e) => e.entrant === name).personId;
  const go = (name, dev) => call('POST', '/api/checkin', {
    body: { eventId: GEV, personId: id(name), acknowledged: true, deviceId: dev },
  });

  let x = await go('Kid A1', 'phone-A');
  check('first junior checks in', x.body.status === 'ok', x.body);
  x = await go('Kid A2', 'phone-A');
  check('sibling with the same guardian is allowed', x.body.status === 'ok', x.body);

  x = await go('Kid B1', 'phone-A');
  check('different guardian is REJECTED', x.body.status === 'already' && x.body.reason === 'guardian', x.body);
  check('...naming the driver already checked in', x.body.previous[0].entrant === 'Kid A1', x.body.previous);
  // privacy: the rejection must not disclose anybody's guardian
  check('...WITHOUT leaking any guardian name', !/Parent \d/.test(JSON.stringify(x.body)), x.body);
  check('...and no guardian field on the previous entry',
    !('guardian' in x.body.previous[0]), x.body.previous[0]);
  check('...and nothing was recorded for them',
    db.prepare('SELECT COUNT(*) c FROM checkins WHERE person_id = ?').get(id('Kid B1')).c === 0);

  x = await go('Kid B1', 'phone-B');
  check('same driver succeeds from their own guardian\'s phone', x.body.status === 'ok', x.body);

  x = await go('Kid C1', 'phone-C');
  check('two-parent sibling 1 ok', x.body.status === 'ok', x.body);
  x = await go('Kid C2', 'phone-C');
  check('sibling listing the same parents in reverse order matches', x.body.status === 'ok', x.body);

  x = await go('Kid D1', 'phone-D');
  check('sibling listing two parents ok', x.body.status === 'ok', x.body);
  x = await go('Kid D2', 'phone-D');
  check('sibling listing only one of those parents still matches', x.body.status === 'ok', x.body);

  // the guardian rule must not disturb the adult budget
  x = await go('Grown Up', 'phone-A');
  check('adult on a junior-bound device is unaffected', x.body.status === 'ok', x.body);

  // guardian mismatch is reported ahead of the 2-junior limit
  x = await go('Kid B1', 'phone-C');
  check('already-checked-in driver still reports as already in',
    x.body.status === 'already' && x.body.reason === 'person', x.body);

  await call('DELETE', '/api/admin/events/' + GEV, { key: ADMIN_KEY });
}

console.log('\n=== 8c. chunked upload matches a single-shot upload ===');
{
  // Create bare, then push the SAME list in 50-row chunks, as the admin page does.
  const made = await call('POST', '/api/admin/events', {
    key: ADMIN_KEY, body: { name: 'Chunked', date: '2026-09-12' },
  });
  const CEV = made.body.event.id;
  check('event created with no rows', made.status === 201 && made.body.entries === 0, made.body);

  let last;
  for (let i = 0; i < ROWS.length; i += 50) {
    last = await call('POST', `/api/admin/events/${CEV}/rows`, {
      key: ADMIN_KEY, body: { rows: ROWS.slice(i, i + 50) },
    });
    if (last.status !== 200) break;
  }
  check('all chunks accepted', last.status === 200, last.body);
  check('same people total as single-shot', last.body.total.people === 247, last.body.total);
  check('same entries total as single-shot', last.body.total.entries === 254, last.body.total);

  // the doubled-up drivers must still collapse even when their two class rows
  // land in different chunks
  const cdet = (await call('GET', '/api/admin/events/' + CEV, { key: ADMIN_KEY })).body;
  const multi = cdet.people.filter(p => p.entries.length > 1);
  check('7 drivers still collapsed across chunks', multi.length === 7, multi.length);
  check('junior flags survived chunking',
    cdet.people.filter(p => p.isJunior).length
      === (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY })).body.people.filter(p => p.isJunior).length,
    cdet.people.filter(p => p.isJunior).length);
  check('no orphan entries', cdet.people.reduce((n, p) => n + p.entries.length, 0) === 254,
    cdet.people.reduce((n, p) => n + p.entries.length, 0));

  await call('DELETE', '/api/admin/events/' + CEV, { key: ADMIN_KEY });
}

console.log('\n=== 9. admin views ===');
r = await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY });
check('detail ok', r.status === 200);
const detail = r.body;
check('247 people listed', detail.people.length === 247, detail.people.length);
const doneCount = detail.people.filter(p => p.checkedIn).length;
check('7 people checked in', doneCount === 7, doneCount);
const missing = detail.people.filter(p => !p.checkedIn);
check('240 not checked in', missing.length === 240, missing.length);
const brodieRow = detail.people.find(p => p.personId === BRODIE);
check('multi-class person appears ONCE in the people list',
  detail.people.filter(p => p.entrant === dupName).length === 1);
check('...with both entries attached', brodieRow.entries.length === 2, brodieRow.entries);
check('client IP recorded', brodieRow.ip === '203.0.113.7', brodieRow.ip);

console.log('\n=== 10. admin manual check-in / undo ===');
const target = missing[0];
r = await call('POST', `/api/admin/events/${EV}/checkin`, { key: ADMIN_KEY, body: { personId: target.personId } });
check('manual check-in ok', r.body.ok === true, r.body);
r = await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY });
let t = r.body.people.find(p => p.personId === target.personId);
check('shows as checked in by admin', t.checkedIn && t.checkinSource === 'admin', t);
r = await call('DELETE', `/api/admin/events/${EV}/checkin/${target.personId}`, { key: ADMIN_KEY });
check('undo ok', r.body.ok === true, r.body);
r = await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY });
t = r.body.people.find(p => p.personId === target.personId);
check('back to not checked in', !t.checkedIn);

console.log('\n=== 11. close / reopen ===');
r = await call('PATCH', '/api/admin/events/' + EV, { key: ADMIN_KEY, body: { status: 'closed' } });
check('closed', r.body.ok === true);
const stillMissing = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY }))
  .body.people.filter(p => !p.checkedIn)[0];
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: stillMissing.personId, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-late' } });
check('check-in refused while closed', r.body.status === 'closed', r.body);
await call('PATCH', '/api/admin/events/' + EV, { key: ADMIN_KEY, body: { status: 'open' } });
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: stillMissing.personId, acknowledged: true, ackText: 'I have read the briefing notes', deviceId: 'dev-late' } });
check('works again after reopen', r.body.status === 'ok', r.body);

console.log('\n=== 12. event list counts ===');
r = await call('GET', '/api/admin/events', { key: ADMIN_KEY });
const ev = r.body.events[0];
check('list shows 247 people / 254 entries', ev.people === 247 && ev.entries === 254, ev);
check('checkedIn count is per person', ev.checkedIn === 8, ev.checkedIn);

console.log('\n=== 13. bad input ===');
r = await call('GET', '/api/events/nosuch');
check('unknown event 404', r.status === 404);
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: 999999, acknowledged: true, deviceId: 'x' } });
check('unknown driver 404', r.status === 404, r.body);
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: 1 } });
check('missing deviceId rejected', r.status === 400, r.body);

console.log('\n=== 13b. briefing acknowledgement is enforced by the API ===');
const ackTarget = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY }))
  .body.people.filter(p => !p.checkedIn)[0];
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: ackTarget.personId, deviceId: 'dev-ack' } });
check('missing acknowledgement rejected', r.status === 400, r.body);
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: ackTarget.personId, acknowledged: false, deviceId: 'dev-ack' } });
check('acknowledged:false rejected', r.status === 400, r.body);
r = await call('POST', '/api/checkin', { body: { eventId: EV, personId: ackTarget.personId, acknowledged: 'yes', deviceId: 'dev-ack' } });
check('truthy-but-not-true rejected', r.status === 400, r.body);
check('...and no check-in was recorded',
  db.prepare('SELECT COUNT(*) c FROM checkins WHERE person_id = ?').get(ackTarget.personId).c === 0);
r = await call('POST', '/api/checkin', {
  body: { eventId: EV, personId: ackTarget.personId, acknowledged: true, ackText: 'Read the notes', deviceId: 'dev-ack' },
});
check('acknowledged check-in succeeds', r.body.status === 'ok', r.body);
const ackRow = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY }))
  .body.people.find(p => p.personId === ackTarget.personId);
check('acknowledgement stored', ackRow.acknowledged === true, ackRow);
check('exact wording stored', ackRow.ackText === 'Read the notes', ackRow.ackText);

console.log('\n=== 13c. official check-in records an acknowledgement too ===');
const admTarget = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY }))
  .body.people.filter(p => !p.checkedIn)[0];
await call('POST', `/api/admin/events/${EV}/checkin`, { key: ADMIN_KEY, body: { personId: admTarget.personId } });
const admRow = (await call('GET', '/api/admin/events/' + EV, { key: ADMIN_KEY }))
  .body.people.find(p => p.personId === admTarget.personId);
check('admin check-in acknowledged', admRow.acknowledged === true, admRow);
check('...and marked as by an official', admRow.checkinSource === 'admin', admRow.checkinSource);
check('...with wording naming the official', /official/i.test(admRow.ackText || ''), admRow.ackText);
r = await call('POST', '/api/admin/events', { key: ADMIN_KEY, body: { rows: [] } });
check('event with no name rejected', r.status === 400, r.body);
// a bare event IS valid now - the admin page creates it, then uploads chunks
r = await call('POST', '/api/admin/events', { key: ADMIN_KEY, body: { name: 'Bare' } });
check('event with no rows is allowed', r.status === 201, r.body);
const bareId = r.body.event.id;
r = await call('POST', `/api/admin/events/${bareId}/rows`, { key: ADMIN_KEY, body: { rows: [] } });
check('empty row chunk rejected', r.status === 400, r.body);
r = await call('POST', '/api/admin/events/nosuch/rows', { key: ADMIN_KEY, body: { rows: [{ entrant: 'A', class: 'B', kartNo: '1' }] } });
check('rows for unknown event rejected', r.status === 404, r.body);
r = await call('POST', `/api/admin/events/${bareId}/rows`, { body: { rows: [{ entrant: 'A', class: 'B', kartNo: '1' }] } });
check('rows endpoint requires the admin key', r.status === 401, r.body);
await call('DELETE', '/api/admin/events/' + bareId, { key: ADMIN_KEY });

console.log('\n=== 14. delete cascades ===');
r = await call('DELETE', '/api/admin/events/' + EV, { key: ADMIN_KEY });
check('deleted', r.body.ok === true);
check('people rows gone', db.prepare('SELECT COUNT(*) c FROM people').get().c === 0);
check('entries rows gone', db.prepare('SELECT COUNT(*) c FROM entries').get().c === 0);
check('checkins rows gone', db.prepare('SELECT COUNT(*) c FROM checkins').get().c === 0);

console.log(`\n${pass} passed, ${failCount} failed\n`);
process.exit(failCount ? 1 : 0);
