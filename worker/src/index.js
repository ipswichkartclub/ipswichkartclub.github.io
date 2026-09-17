/**
 * IKC Driver Briefing Check-in API
 * Cloudflare Worker + D1.
 *
 * Identity model: a PERSON (keyed on CRN) may hold several ENTRIES (one per
 * class). Checking in once satisfies every entry that person holds.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/* ------------------------------------------------------------------ utils */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allow = allowed.includes('*') || allowed.includes(origin) ? (origin || '*') : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) },
  });
}

function fail(message, request, env, status = 400, extra = {}) {
  return json({ error: message, ...extra }, request, env, status);
}

function isAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const key = env.ADMIN_KEY || '';
  if (!key || !token || token.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
function makeSlug(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

const nowIso = () => new Date().toISOString();

function normaliseName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isJuniorGuardian(guardian) {
  const g = String(guardian || '').trim();
  return g !== '' && g.toLowerCase() !== 'not applicable';
}

/**
 * Break a Guardian cell into its individual guardians.
 * The column looks like "Nathan Mills (22011751), Katrice Mills (202400033)",
 * where the bracketed value is that guardian's member number.
 */
function parseGuardians(raw) {
  const text = String(raw || '').trim();
  if (!text || text.toLowerCase() === 'not applicable') return [];

  const out = [];
  const re = /([^,()]+?)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ name: normaliseName(m[1]), id: m[2].trim().toLowerCase() });
  }
  if (out.length) return out;

  // no bracketed numbers - fall back to comma separated names
  return text.split(',')
    .map((s) => normaliseName(s))
    .filter(Boolean)
    .map((name) => ({ name, id: '' }));
}

/**
 * Identity keys are how we decide "these are the same person".
 * Both the member number and the name are emitted so a match succeeds on
 * either: entry lists are inconsistent about which is present.
 */
function guardianKeys(guardian) {
  const keys = [];
  for (const g of parseGuardians(guardian)) {
    if (g.id) keys.push('id:' + g.id);
    if (g.name) keys.push('name:' + g.name);
  }
  return keys;
}

/** Who this person IS, as opposed to who is responsible for them. */
function personKeys(person) {
  const keys = [];
  const crn = String(person.crn || '').trim().toLowerCase();
  const name = normaliseName(person.entrant);
  if (crn) keys.push('id:' + crn);
  if (name) keys.push('name:' + name);
  return keys;
}

/**
 * The identity a check-in binds a device to.
 *
 * An adult binds the device to themselves. A junior binds it to their
 * guardian. Every later check-in on that device must resolve to the same
 * person, which is what stops someone checking in a child they are not
 * responsible for, in either order.
 */
function identityKeys(person) {
  const junior = person.is_junior !== undefined ? person.is_junior : person.isJunior;
  return junior ? guardianKeys(person.guardian) : personKeys(person);
}

function keysOverlap(a, b) {
  if (!a.length || !b.length) return false;
  return a.some((k) => b.indexOf(k) !== -1);
}

/**
 * Backstop caps per device. The identity rule below is the real control, so
 * these only exist to bound abuse: the junior cap must be high enough to cover
 * the largest family actually racing (there are 3-child families in the 2026
 * IROC list). Override with DEVICE_LIMIT_ADULT / DEVICE_LIMIT_JUNIOR.
 */
function deviceLimits(env) {
  const adult = parseInt(env.DEVICE_LIMIT_ADULT, 10);
  const junior = parseInt(env.DEVICE_LIMIT_JUNIOR, 10);
  return {
    adult: Number.isFinite(adult) && adult > 0 ? adult : 1,
    junior: Number.isFinite(junior) && junior > 0 ? junior : 4,
  };
}

async function chunkedBatch(db, statements, size = 50) {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

/* ----------------------------------------------------------------- router */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const seg = path.split('/').filter(Boolean);

    try {
      if (path === '/' || path === '/api') {
        return json({ ok: true, service: 'ikc-checkin', time: nowIso() }, request, env);
      }

      /* ---------------------------------------------------------- public */

      // GET /api/events/:id  -> roster for the check-in page
      if (request.method === 'GET' && seg[0] === 'api' && seg[1] === 'events' && seg.length === 3) {
        return await getPublicEvent(seg[2], request, env);
      }

      // POST /api/checkin
      if (request.method === 'POST' && seg[0] === 'api' && seg[1] === 'checkin' && seg.length === 2) {
        return await postCheckin(request, env);
      }

      /* ----------------------------------------------------------- admin */

      if (seg[0] === 'api' && seg[1] === 'admin') {
        if (!isAdmin(request, env)) return fail('Unauthorised', request, env, 401);

        if (request.method === 'GET' && seg[2] === 'ping') return json({ ok: true }, request, env);

        if (seg[2] === 'events' && seg.length === 3) {
          if (request.method === 'GET') return await listEvents(request, env);
          if (request.method === 'POST') return await createEvent(request, env);
        }

        if (seg[2] === 'events' && seg.length === 4) {
          if (request.method === 'GET') return await getEventDetail(seg[3], request, env);
          if (request.method === 'PATCH') return await patchEvent(seg[3], request, env);
          if (request.method === 'DELETE') return await deleteEvent(seg[3], request, env);
        }

        // POST /api/admin/events/:id/rows - append a chunk of the entry list
        if (seg[2] === 'events' && seg[4] === 'rows' && seg.length === 5 && request.method === 'POST') {
          return await appendRows(seg[3], request, env);
        }

        if (seg[2] === 'events' && seg[4] === 'checkin') {
          if (request.method === 'POST' && seg.length === 5) {
            return await adminCheckin(seg[3], request, env);
          }
          if (request.method === 'DELETE' && seg.length === 6) {
            return await adminUndoCheckin(seg[3], Number(seg[5]), request, env);
          }
        }
      }

      return fail('Not found', request, env, 404);
    } catch (err) {
      return fail(err && err.message ? err.message : 'Server error', request, env, 500);
    }
  },
};

/* ------------------------------------------------------------ public API */

async function getPublicEvent(eventId, request, env) {
  const event = await env.DB.prepare(
    'SELECT id, name, event_date, status FROM events WHERE id = ?'
  ).bind(eventId).first();
  if (!event) return fail('Event not found', request, env, 404);

  const { results } = await env.DB.prepare(
    `SELECT e.id        AS entryId,
            e.person_id AS personId,
            e.kart_no   AS kartNo,
            e.class     AS class,
            p.entrant   AS entrant,
            p.is_junior AS isJunior,
            (c.id IS NOT NULL) AS checkedIn
       FROM entries e
       JOIN people p ON p.id = e.person_id
       LEFT JOIN checkins c ON c.person_id = e.person_id AND c.event_id = e.event_id
      WHERE e.event_id = ?
      ORDER BY e.class, CAST(e.kart_no AS INTEGER), e.kart_no`
  ).bind(eventId).all();

  const entries = results.map((r) => ({
    entryId: r.entryId,
    personId: r.personId,
    kartNo: String(r.kartNo),
    class: r.class,
    entrant: r.entrant,
    isJunior: !!r.isJunior,
    checkedIn: !!r.checkedIn,
  }));

  const classes = [];
  for (const e of entries) if (!classes.includes(e.class)) classes.push(e.class);

  return json({
    event: { id: event.id, name: event.name, date: event.event_date, status: event.status },
    classes,
    entries,
  }, request, env);
}

async function postCheckin(request, env) {
  const body = await request.json().catch(() => ({}));
  const eventId = String(body.eventId || '');
  const personId = Number(body.personId);
  const deviceId = String(body.deviceId || '').slice(0, 64);

  if (!eventId || !personId) return fail('eventId and personId are required', request, env);
  if (!deviceId) return fail('deviceId is required', request, env);

  // The briefing acknowledgement is enforced here, not just by the checkbox on
  // the page, so a check-in record always means the driver actually ticked it.
  if (body.acknowledged !== true) {
    return fail('The driver briefing acknowledgement is required', request, env, 400);
  }
  const ackText = String(body.ackText || '').slice(0, 500);

  const event = await env.DB.prepare(
    'SELECT id, name, status FROM events WHERE id = ?'
  ).bind(eventId).first();
  if (!event) return fail('Event not found', request, env, 404);
  if (event.status !== 'open') {
    return json({ status: 'closed', event: { id: event.id, name: event.name } }, request, env);
  }

  // guardian is read for the matching rule below, but never returned to the page
  const person = await env.DB.prepare(
    'SELECT id, entrant, guardian, is_junior FROM people WHERE id = ? AND event_id = ?'
  ).bind(personId, eventId).first();
  if (!person) return fail('Driver not found for this event', request, env, 404);

  const personPayload = await describePerson(env, eventId, personId);

  // 1. Already checked in? (person-level, regardless of device)
  const existing = await env.DB.prepare(
    'SELECT created_at, source FROM checkins WHERE event_id = ? AND person_id = ?'
  ).bind(eventId, personId).first();
  if (existing) {
    return json({
      status: 'already',
      reason: 'person',
      person: personPayload,
      checkedInAt: existing.created_at,
    }, request, env);
  }

  // 2. Device allowance, budgeted separately for adults and juniors so a racing
  //    parent can do their kids and themselves from the one phone.
  const prior = await env.DB.prepare(
    `SELECT p.id, p.entrant, p.crn, p.guardian, p.is_junior AS isJunior, c.created_at
       FROM checkins c JOIN people p ON p.id = c.person_id
      WHERE c.event_id = ? AND c.device_id = ? AND c.source = 'self'
      ORDER BY c.created_at`
  ).bind(eventId, deviceId).all();

  const limits = deviceLimits(env);
  const isJunior = !!person.is_junior;
  const sameKind = prior.results.filter((r) => !!r.isJunior === isJunior);
  const allowance = isJunior ? limits.junior : limits.adult;

  // A device is bound to ONE person by its first check-in: an adult binds it to
  // themselves, a junior binds it to their guardian. Everything after that must
  // resolve to the same person. This covers all three orderings - driver then
  // minor, minor then minor, and minor then driver.
  if (prior.results.length) {
    const established = [];
    for (const r of prior.results) {
      for (const k of identityKeys(r)) if (established.indexOf(k) === -1) established.push(k);
    }
    if (!keysOverlap(identityKeys(person), established)) {
      // Names of drivers checked in on THIS device are fine to return - whoever
      // holds the phone checked them in. Guardian names are never returned.
      const first = prior.results[0];
      return json({
        status: 'already',
        reason: 'identity',
        person: personPayload,
        boundTo: first.isJunior ? 'guardian' : 'driver',
        previous: prior.results.map((r) => ({
          entrant: r.entrant,
          isJunior: !!r.isJunior,
          checkedInAt: r.created_at,
        })),
      }, request, env);
    }
  }

  if (sameKind.length >= allowance) {
    return json({
      status: 'already',
      reason: 'device',
      allowance,
      person: personPayload,
      previous: sameKind.map((r) => ({ entrant: r.entrant, checkedInAt: r.created_at })),
    }, request, env);
  }

  // 3. Record it.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 300);
  const at = nowIso();

  try {
    await env.DB.prepare(
      `INSERT INTO checkins (event_id, person_id, device_id, ip, user_agent, source, acknowledged, ack_text, created_at)
       VALUES (?, ?, ?, ?, ?, 'self', 1, ?, ?)`
    ).bind(eventId, personId, deviceId, ip, ua, ackText, at).run();
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      const row = await env.DB.prepare(
        'SELECT created_at FROM checkins WHERE event_id = ? AND person_id = ?'
      ).bind(eventId, personId).first();
      return json({
        status: 'already',
        reason: 'person',
        person: personPayload,
        checkedInAt: row ? row.created_at : at,
      }, request, env);
    }
    throw err;
  }

  return json({ status: 'ok', person: personPayload, checkedInAt: at }, request, env);
}

/**
 * The public shape of a driver. Guardian details, CRN and contact details are
 * deliberately absent: the check-in page is unauthenticated, so anything
 * returned here is readable by anyone with the event link. Admin endpoints
 * return the full record instead.
 */
async function describePerson(env, eventId, personId) {
  const person = await env.DB.prepare(
    'SELECT id, entrant, is_junior AS isJunior FROM people WHERE id = ? AND event_id = ?'
  ).bind(personId, eventId).first();
  const { results } = await env.DB.prepare(
    `SELECT kart_no AS kartNo, class FROM entries
      WHERE event_id = ? AND person_id = ?
      ORDER BY class`
  ).bind(eventId, personId).all();
  return {
    personId: person.id,
    entrant: person.entrant,
    isJunior: !!person.isJunior,
    entries: results.map((r) => ({ kartNo: String(r.kartNo), class: r.class })),
  };
}

/* ------------------------------------------------------------- admin API */

async function listEvents(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.name, e.event_date AS date, e.status, e.created_at AS createdAt,
            (SELECT COUNT(*) FROM people   p WHERE p.event_id = e.id) AS people,
            (SELECT COUNT(*) FROM entries  n WHERE n.event_id = e.id) AS entries,
            (SELECT COUNT(*) FROM checkins c WHERE c.event_id = e.id) AS checkedIn
       FROM events e
      ORDER BY COALESCE(e.event_date, e.created_at) DESC, e.created_at DESC`
  ).all();
  return json({ events: results }, request, env);
}

/**
 * Turn raw spreadsheet rows into people (keyed on CRN, else normalised name)
 * and entries, then write them to an existing event.
 *
 * Callable repeatedly with chunks of the same list: people are inserted with
 * INSERT OR IGNORE against UNIQUE(event_id, person_key), so a driver whose
 * class entries land in different chunks still collapses to one person.
 */
async function insertRows(eventId, rows, env) {
  const peopleByKey = new Map();
  const entryRows = [];

  rows.forEach((r, i) => {
    const entrant = String(r.entrant || '').trim();
    const cls = String(r.class || '').trim();
    const kartNo = String(r.kartNo == null ? '' : r.kartNo).trim();
    if (!entrant || !cls) return;

    const crn = String(r.crn || '').trim();
    const key = crn || normaliseName(entrant);
    const junior = isJuniorGuardian(r.guardian);

    if (!peopleByKey.has(key)) {
      peopleByKey.set(key, {
        key,
        entrant,
        guardian: String(r.guardian || '').trim(),
        isJunior: junior,
        crn,
        email: String(r.email || '').trim(),
        mobile: String(r.mobile || '').trim(),
        homeClub: String(r.homeClub || '').trim(),
      });
    } else if (junior) {
      peopleByKey.get(key).isJunior = true;
    }

    entryRows.push({
      key,
      kartNo,
      class: cls,
      transponder: String(r.transponder || '').trim(),
      kart: String(r.kart || '').trim(),
      engine: String(r.engine || '').trim(),
      memberType: String(r.memberType || '').trim(),
      rowNo: i + 1,
    });
  });

  if (!peopleByKey.size) return { people: 0, entries: 0 };

  const personStmt = env.DB.prepare(
    `INSERT OR IGNORE INTO people (event_id, person_key, entrant, guardian, is_junior, crn, email, mobile, home_club)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await chunkedBatch(env.DB, [...peopleByKey.values()].map((p) => personStmt.bind(
    eventId, p.key, p.entrant, p.guardian, p.isJunior ? 1 : 0, p.crn, p.email, p.mobile, p.homeClub
  )));

  // A person first seen without a guardian in an earlier chunk must still end
  // up flagged as a junior if any of their rows names one.
  const juniorKeys = [...peopleByKey.values()].filter((p) => p.isJunior).map((p) => p.key);
  if (juniorKeys.length) {
    const upd = env.DB.prepare(
      'UPDATE people SET is_junior = 1 WHERE event_id = ? AND person_key = ? AND is_junior = 0'
    );
    await chunkedBatch(env.DB, juniorKeys.map((k) => upd.bind(eventId, k)));
  }

  // Resolve person ids for just the keys in this chunk.
  const keys = [...peopleByKey.keys()];
  const idByKey = new Map();
  for (let i = 0; i < keys.length; i += 40) {
    const slice = keys.slice(i, i + 40);
    const { results } = await env.DB.prepare(
      `SELECT id, person_key FROM people
        WHERE event_id = ? AND person_key IN (${slice.map(() => '?').join(',')})`
    ).bind(eventId, ...slice).all();
    results.forEach((p) => idByKey.set(p.person_key, p.id));
  }

  const entryStmt = env.DB.prepare(
    `INSERT INTO entries (event_id, person_id, kart_no, class, transponder, kart, engine, member_type, row_no)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await chunkedBatch(env.DB, entryRows.map((e) => entryStmt.bind(
    eventId, idByKey.get(e.key), e.kartNo, e.class, e.transponder, e.kart, e.engine, e.memberType, e.rowNo
  )));

  return { people: peopleByKey.size, entries: entryRows.length };
}

async function createEvent(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const date = String(body.date || '').trim() || null;
  const rows = Array.isArray(body.rows) ? body.rows : [];

  if (!name) return fail('Event name is required', request, env);

  let id = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = makeSlug(6);
    const clash = await env.DB.prepare('SELECT 1 FROM events WHERE id = ?').bind(candidate).first();
    if (!clash) { id = candidate; break; }
  }
  if (!id) return fail('Could not allocate an event id, please try again', request, env, 500);

  await env.DB.prepare(
    'INSERT INTO events (id, name, event_date, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, name, date, 'open', nowIso()).run();

  // Rows are optional here: the admin page creates the event, then uploads the
  // entry list in chunks so no single request runs long enough to hit the
  // Workers free-tier CPU limit.
  const added = rows.length ? await insertRows(id, rows, env) : { people: 0, entries: 0 };

  return json({
    event: { id, name, date, status: 'open' },
    people: added.people,
    entries: added.entries,
  }, request, env, 201);
}

async function appendRows(eventId, request, env) {
  const body = await request.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return fail('No driver rows supplied', request, env);

  const event = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(eventId).first();
  if (!event) return fail('Event not found', request, env, 404);

  const added = await insertRows(eventId, rows, env);

  const totals = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM people  WHERE event_id = ?) AS people,
            (SELECT COUNT(*) FROM entries WHERE event_id = ?) AS entries`
  ).bind(eventId, eventId).first();

  return json({ added, total: totals }, request, env);
}

async function getEventDetail(eventId, request, env) {
  const event = await env.DB.prepare(
    'SELECT id, name, event_date, status, created_at FROM events WHERE id = ?'
  ).bind(eventId).first();
  if (!event) return fail('Event not found', request, env, 404);

  const { results: people } = await env.DB.prepare(
    `SELECT p.id, p.entrant, p.is_junior AS isJunior, p.guardian, p.crn,
            p.email, p.mobile, p.home_club AS homeClub,
            c.created_at AS checkedInAt, c.source AS checkinSource, c.ip AS ip,
            c.acknowledged AS acknowledged, c.ack_text AS ackText
       FROM people p
       LEFT JOIN checkins c ON c.person_id = p.id AND c.event_id = p.event_id
      WHERE p.event_id = ?
      ORDER BY p.entrant COLLATE NOCASE`
  ).bind(eventId).all();

  const { results: entries } = await env.DB.prepare(
    `SELECT id, person_id AS personId, kart_no AS kartNo, class, transponder, member_type AS memberType
       FROM entries WHERE event_id = ?
      ORDER BY class, CAST(kart_no AS INTEGER), kart_no`
  ).bind(eventId).all();

  const byPerson = new Map();
  for (const e of entries) {
    if (!byPerson.has(e.personId)) byPerson.set(e.personId, []);
    byPerson.get(e.personId).push({
      kartNo: String(e.kartNo),
      class: e.class,
      transponder: e.transponder,
      memberType: e.memberType,
    });
  }

  return json({
    event: {
      id: event.id,
      name: event.name,
      date: event.event_date,
      status: event.status,
      createdAt: event.created_at,
    },
    people: people.map((p) => ({
      personId: p.id,
      entrant: p.entrant,
      isJunior: !!p.isJunior,
      guardian: p.guardian,
      crn: p.crn,
      email: p.email,
      mobile: p.mobile,
      homeClub: p.homeClub,
      checkedIn: !!p.checkedInAt,
      checkedInAt: p.checkedInAt,
      checkinSource: p.checkinSource,
      acknowledged: !!p.acknowledged,
      ackText: p.ackText,
      ip: p.ip,
      entries: byPerson.get(p.id) || [],
    })),
  }, request, env);
}

async function patchEvent(eventId, request, env) {
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const binds = [];
  if (typeof body.name === 'string' && body.name.trim()) {
    sets.push('name = ?'); binds.push(body.name.trim());
  }
  if (typeof body.date === 'string') {
    sets.push('event_date = ?'); binds.push(body.date.trim() || null);
  }
  if (body.status === 'open' || body.status === 'closed') {
    sets.push('status = ?'); binds.push(body.status);
  }
  if (!sets.length) return fail('Nothing to update', request, env);

  binds.push(eventId);
  const res = await env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  if (!res.meta.changes) return fail('Event not found', request, env, 404);
  return json({ ok: true }, request, env);
}

async function deleteEvent(eventId, request, env) {
  // D1 does not apply ON DELETE CASCADE by default, so clear children explicitly.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM checkins WHERE event_id = ?').bind(eventId),
    env.DB.prepare('DELETE FROM entries  WHERE event_id = ?').bind(eventId),
    env.DB.prepare('DELETE FROM people   WHERE event_id = ?').bind(eventId),
    env.DB.prepare('DELETE FROM events   WHERE id = ?').bind(eventId),
  ]);
  return json({ ok: true }, request, env);
}

async function adminCheckin(eventId, request, env) {
  const body = await request.json().catch(() => ({}));
  const personId = Number(body.personId);
  if (!personId) return fail('personId is required', request, env);

  const person = await env.DB.prepare(
    'SELECT id FROM people WHERE id = ? AND event_id = ?'
  ).bind(personId, eventId).first();
  if (!person) return fail('Driver not found for this event', request, env, 404);

  // An official checking someone in is vouching that the driver acknowledged
  // the briefing notes; the 'admin' source keeps the two cases distinguishable.
  const ackText = String(body.ackText || 'Acknowledgement confirmed by an official').slice(0, 500);
  const at = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO checkins (event_id, person_id, device_id, ip, user_agent, source, acknowledged, ack_text, created_at)
     VALUES (?, ?, NULL, ?, 'admin', 'admin', 1, ?, ?)`
  ).bind(eventId, personId, request.headers.get('CF-Connecting-IP') || '', ackText, at).run();

  return json({ ok: true, checkedInAt: at }, request, env);
}

async function adminUndoCheckin(eventId, personId, request, env) {
  if (!personId) return fail('personId is required', request, env);
  await env.DB.prepare(
    'DELETE FROM checkins WHERE event_id = ? AND person_id = ?'
  ).bind(eventId, personId).run();
  return json({ ok: true }, request, env);
}
