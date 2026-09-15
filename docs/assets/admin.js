/* Driver briefing check-in - admin console */
(function () {
  'use strict';

  var RAW = (window.IKC_CONFIG && typeof window.IKC_CONFIG.apiBase === 'string')
    ? window.IKC_CONFIG.apiBase : null;
  // An empty apiBase is valid: it means "same origin" (the local dev server).
  var API = RAW === null ? '' : RAW.replace(/\/+$/, '');
  var CONFIGURED = RAW !== null && API.indexOf('YOUR-SUBDOMAIN') === -1;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    key: '',
    events: [],
    detail: null,      // { event, people[] }
    tab: 'missing',
    parsed: null,      // { rows, summary }
    timer: null,
    loading: false,
    lastUpdated: null,
    collapsed: {},     // class name -> true, for the By class view
    sig: null,         // fingerprint of the last rendered list
  };

  var REFRESH_MS = 15000;

  /* --------------------------------------------------------------- util */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return 'No date set';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  }

  function kartSort(a, b) {
    var na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  }

  function show(view) {
    ['viewLogin', 'viewEvents', 'viewEvent'].forEach(function (v) {
      $(v).classList.toggle('hidden', v !== view);
    });
    $('logoutBtn').classList.toggle('hidden', view === 'viewLogin');
    window.scrollTo(0, 0);
  }

  function checkinUrl(eventId) {
    var base = location.origin + location.pathname.replace(/admin\.html?$/i, '');
    if (!/\/$/.test(base)) base += '/';
    return base + 'index.html?e=' + encodeURIComponent(eventId);
  }

  /* ---------------------------------------------------------------- api */

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      Authorization: 'Bearer ' + state.key,
    });
    if (options.body) options.headers['content-type'] = 'application/json';

    return fetch(API + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 401) { signOut(); throw new Error('Session expired, sign in again'); }
        if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
        return body;
      });
    });
  }

  /* -------------------------------------------------------------- login */

  function signOut() {
    state.key = '';
    try { sessionStorage.removeItem('ikc_admin_key'); } catch (e) { /* ignore */ }
    stopAuto();
    show('viewLogin');
  }

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var key = $('adminKey').value.trim();
    if (!key) return;
    state.key = key;
    $('loginError').classList.add('hidden');

    api('/api/admin/ping')
      .then(function () {
        try { sessionStorage.setItem('ikc_admin_key', key); } catch (e) { /* ignore */ }
        openEvents();
      })
      .catch(function (err) {
        state.key = '';
        $('loginError').textContent = err.message || 'That key was not accepted';
        $('loginError').classList.remove('hidden');
      });
  });

  $('logoutBtn').addEventListener('click', signOut);

  /* ------------------------------------------------------- events list */

  function openEvents() {
    stopAuto();
    show('viewEvents');
    loadEvents();
  }

  function loadEvents() {
    $('eventsList').innerHTML = '<p class="muted"><span class="spinner"></span>Loading…</p>';
    api('/api/admin/events')
      .then(function (data) {
        state.events = data.events || [];
        renderEvents();
      })
      .catch(function (err) {
        $('eventsList').innerHTML = '<div class="notice error">' + esc(err.message) + '</div>';
      });
  }

  function renderEvents() {
    if (!state.events.length) {
      $('eventsList').innerHTML =
        '<div class="card"><p class="empty">No race meetings yet. Create one above.</p></div>';
      $('eventsSub').textContent = '';
      return;
    }
    $('eventsSub').textContent = state.events.length + ' meeting' + (state.events.length === 1 ? '' : 's');

    // The whole panel is the button - there is only one action per meeting.
    $('eventsList').innerHTML = state.events.map(function (e) {
      var missing = e.people - e.checkedIn;
      var pct = e.people ? Math.round((e.checkedIn / e.people) * 100) : 0;

      return '<button type="button" class="event-card" data-open="' + esc(e.id) + '">' +
        '<span class="ec-main">' +
          '<span class="ec-title">' +
            '<b>' + esc(e.name) + '</b>' +
            '<span class="tag ' + (e.status === 'open' ? 'open' : 'closed') + '">' + esc(e.status) + '</span>' +
          '</span>' +
          '<span class="ec-sub">' + esc(formatDate(e.date)) + ' · ' +
            e.people + ' drivers · ' + e.entries + ' entries</span>' +
          '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="ec-counts">' +
            (missing
              ? '<b class="ec-missing">' + missing + ' still to check in</b>' +
                '<span class="ec-in">' + e.checkedIn + ' of ' + e.people + ' done</span>'
              : '<b class="ec-done">All ' + e.people + ' drivers checked in</b>') +
          '</span>' +
        '</span>' +
        '<span class="ec-go" aria-hidden="true">&#8250;</span>' +
      '</button>';
    }).join('');
  }

  $('eventsList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-open]');
    if (btn) openEvent(btn.getAttribute('data-open'));
  });

  /* ----------------------------------------------------- spreadsheet in */

  var HEADER_MAP = {
    kartno: 'kartNo', kart_no: 'kartNo', kartnumber: 'kartNo', no: 'kartNo', number: 'kartNo',
    entrant: 'entrant', driver: 'entrant', name: 'entrant', competitor: 'entrant', drivername: 'entrant',
    class: 'class', category: 'class',
    guardian: 'guardian', guardians: 'guardian', parentguardian: 'guardian',
    crn: 'crn', licenceno: 'crn', licenseno: 'crn',
    transpondernumber: 'transponder', transponder: 'transponder',
    kart: 'kart', chassis: 'kart',
    engine: 'engine',
    email: 'email', emailaddress: 'email',
    mobile: 'mobile', phone: 'mobile', mobilenumber: 'mobile',
    membertype: 'memberType',
    homeclub: 'homeClub', club: 'homeClub',
  };

  function normaliseHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function parseWorkbook(file) {
    return file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' });
      var sheet = wb.Sheets[wb.SheetNames[0]];
      var grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
      if (!grid.length) throw new Error('That file has no rows');

      // find the header row: the first row that maps to entrant AND class
      var headerIdx = -1, mapping = null;
      for (var i = 0; i < Math.min(grid.length, 15); i++) {
        var m = grid[i].map(function (h) { return HEADER_MAP[normaliseHeader(h)] || null; });
        if (m.indexOf('entrant') !== -1 && m.indexOf('class') !== -1) { headerIdx = i; mapping = m; break; }
      }
      if (headerIdx === -1) {
        throw new Error('Could not find the header row. The sheet needs columns named Entrant and Class (Kart No too).');
      }

      var rows = [];
      for (var r = headerIdx + 1; r < grid.length; r++) {
        var raw = grid[r];
        if (!raw || !raw.length) continue;
        var obj = {};
        mapping.forEach(function (field, c) {
          if (!field) return;
          var v = raw[c];
          obj[field] = v == null ? '' : String(v).trim();
        });
        if (!obj.entrant || !obj.class) continue;
        rows.push(obj);
      }
      if (!rows.length) throw new Error('No data rows found under the header');
      return rows;
    });
  }

  function summarise(rows) {
    var people = new Map();
    var classes = new Map();
    var warnings = [];
    var missingCrn = 0;
    var missingKart = 0;

    rows.forEach(function (r) {
      var crn = (r.crn || '').trim();
      if (!crn) missingCrn++;
      if (!String(r.kartNo || '').trim()) missingKart++;
      var key = crn || (r.entrant || '').trim().toLowerCase().replace(/\s+/g, ' ');
      var junior = (r.guardian || '').trim() !== '' && (r.guardian || '').trim().toLowerCase() !== 'not applicable';
      if (!people.has(key)) people.set(key, { entrant: r.entrant, junior: junior, entries: 0 });
      else if (junior) people.get(key).junior = true;
      people.get(key).entries++;
      classes.set(r.class, (classes.get(r.class) || 0) + 1);
    });

    var multi = [...people.values()].filter(function (p) { return p.entries > 1; });
    if (multi.length) {
      warnings.push(multi.length + ' driver' + (multi.length === 1 ? ' is' : 's are') +
        ' entered in more than one class (' +
        multi.slice(0, 4).map(function (p) { return p.entrant; }).join(', ') +
        (multi.length > 4 ? ', …' : '') +
        '). They only need to check in once.');
    }
    if (missingCrn) {
      warnings.push(missingCrn + ' row' + (missingCrn === 1 ? ' has' : 's have') +
        ' no CRN, so those drivers will be matched by name instead.');
    }
    if (missingKart) {
      warnings.push(missingKart + ' row' + (missingKart === 1 ? ' has' : 's have') + ' no kart number.');
    }

    return {
      people: people.size,
      entries: rows.length,
      classes: [...classes.entries()].sort(function (a, b) { return a[0].localeCompare(b[0]); }),
      juniors: [...people.values()].filter(function (p) { return p.junior; }).length,
      warnings: warnings,
    };
  }

  $('newFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    $('parseError').classList.add('hidden');
    $('parseWarn').classList.add('hidden');
    $('previewBox').classList.add('hidden');
    $('createBtn').disabled = true;
    state.parsed = null;
    if (!file) return;

    // suggest an event name from the filename
    if (!$('newName').value.trim()) {
      $('newName').value = file.name.replace(/\.(xlsx|xls|csv)$/i, '').replace(/[_-]+/g, ' ').trim();
    }

    parseWorkbook(file)
      .then(function (rows) {
        var sum = summarise(rows);
        state.parsed = { rows: rows, summary: sum };

        $('pvPeople').textContent = sum.people;
        $('pvEntries').textContent = sum.entries;
        $('pvClasses').textContent = sum.classes.length;
        $('pvJuniors').textContent = sum.juniors;

        $('pvTable').innerHTML =
          '<tr><th>Class</th><th style="text-align:right">Entries</th></tr>' +
          sum.classes.map(function (c) {
            return '<tr><td>' + esc(c[0]) + '</td><td class="n">' + c[1] + '</td></tr>';
          }).join('');

        if (sum.warnings.length) {
          $('parseWarn').innerHTML = sum.warnings.map(esc).join('<br>');
          $('parseWarn').classList.remove('hidden');
        }
        $('previewBox').classList.remove('hidden');
        $('createBtn').disabled = false;
      })
      .catch(function (err) {
        $('parseError').textContent = err.message;
        $('parseError').classList.remove('hidden');
      });
  });

  $('createBtn').addEventListener('click', function () {
    var name = $('newName').value.trim();
    if (!name) { $('newName').focus(); return; }
    if (!state.parsed) return;

    var btn = this;
    var rows = state.parsed.rows;
    btn.disabled = true;
    $('createError').classList.add('hidden');

    // Upload in chunks: one request per ~50 rows keeps every call well inside
    // the Workers free-tier CPU limit, and gives us a progress read-out.
    var CHUNK = 50;
    var sent = 0;

    function progress() {
      btn.innerHTML = '<span class="spinner"></span>Uploading ' + sent + ' of ' + rows.length + '…';
    }

    function sendFrom(eventId, i) {
      if (i >= rows.length) return Promise.resolve(eventId);
      var slice = rows.slice(i, i + CHUNK);
      return api('/api/admin/events/' + encodeURIComponent(eventId) + '/rows', {
        method: 'POST',
        body: JSON.stringify({ rows: slice }),
      }).then(function () {
        sent += slice.length;
        progress();
        return sendFrom(eventId, i + CHUNK);
      });
    }

    progress();
    api('/api/admin/events', {
      method: 'POST',
      body: JSON.stringify({ name: name, date: $('newDate').value || null }),
    })
      .then(function (res) { return sendFrom(res.event.id, 0); })
      .then(function (eventId) {
        $('newName').value = '';
        $('newDate').value = '';
        $('newFile').value = '';
        $('previewBox').classList.add('hidden');
        $('parseWarn').classList.add('hidden');
        state.parsed = null;
        btn.textContent = 'Create event';
        btn.disabled = false;
        openEvent(eventId);
      })
      .catch(function (err) {
        $('createError').textContent = err.message
          + (sent ? ' (' + sent + ' of ' + rows.length + ' rows were uploaded; '
            + 'delete the part-created meeting and try again)' : '');
        $('createError').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Create event';
      });
  });

  /* ------------------------------------------------------ event detail */

  function openEvent(id) {
    show('viewEvent');
    state.sig = null;
    state.collapsed = {};
    $('paneBody').innerHTML = '<p class="muted"><span class="spinner"></span>Loading…</p>';
    loadDetail(id).then(function () {
      renderQr(id);
      startAuto();
    });
  }

  /**
   * Reload the event. `quiet` leaves the current list on screen while the
   * request is in flight - used by the polling timer and tab switches so the
   * page never flickers or loses your place.
   */
  function loadDetail(id, quiet) {
    // Skip a background poll while another request is in flight, but never skip
    // an explicit one - a check-in must always be followed by fresh data.
    if (state.loading && quiet) return Promise.resolve();
    state.loading = true;
    if (!quiet) $('refreshBtn').disabled = true;
    $('lastUpdated').innerHTML = '<span class="spinner" style="width:11px;height:11px"></span>Updating…';

    return api('/api/admin/events/' + encodeURIComponent(id))
      .then(function (data) {
        state.detail = data;
        state.lastUpdated = new Date();
        renderDetail();
      })
      .catch(function (err) {
        if (!quiet) $('paneBody').innerHTML = '<div class="notice error">' + esc(err.message) + '</div>';
        $('lastUpdated').textContent = 'Update failed';
      })
      .then(function () {
        state.loading = false;
        $('refreshBtn').disabled = false;
        stampUpdated();
      });
  }

  function stampUpdated() {
    if (!state.lastUpdated) return;
    $('lastUpdated').textContent = 'Updated ' +
      state.lastUpdated.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) +
      (state.timer ? '' : ' · auto-refresh off');
  }

  function renderDetail() {
    var d = state.detail;
    if (!d) return;
    var people = d.people;
    var done = people.filter(function (p) { return p.checkedIn; }).length;
    var entries = people.reduce(function (n, p) { return n + p.entries.length; }, 0);

    $('evName').textContent = d.event.name;
    $('evDate').textContent = formatDate(d.event.date);
    $('evStatus').innerHTML = ' <span class="tag ' + (d.event.status === 'open' ? 'open' : 'closed') + '">'
      + esc(d.event.status) + '</span>';

    $('stMissing').textContent = people.length - done;
    $('stDone').textContent = done;
    $('stPeople').textContent = people.length;
    $('stEntries').textContent = entries;
    $('stBar').style.width = people.length ? Math.round((done / people.length) * 100) + '%' : '0%';
    $('stCaption').textContent = done + ' of ' + people.length + ' drivers checked in'
      + (entries !== people.length ? ' (' + entries + ' entries across all classes)' : '');

    $('toggleStatusBtn').textContent = d.event.status === 'open' ? 'Close check-in' : 'Reopen check-in';

    // Only redraw the list when something actually changed, so a background
    // refresh never flickers or moves a button out from under your finger.
    var sig = d.event.status + '|' + people.map(function (p) {
      return p.personId + (p.checkedIn ? '1' : '0') + (p.checkinSource || '');
    }).join(',');
    if (sig !== state.sig) {
      state.sig = sig;
      renderPane();
    }
  }

  function filteredPeople() {
    var q = $('peopleSearch').value.trim().toLowerCase();
    var people = state.detail.people;
    if (!q) return people;
    return people.filter(function (p) {
      if (p.entrant.toLowerCase().indexOf(q) !== -1) return true;
      if ((p.crn || '').toLowerCase().indexOf(q) !== -1) return true;
      return p.entries.some(function (e) {
        return e.class.toLowerCase().indexOf(q) !== -1 || String(e.kartNo).toLowerCase().indexOf(q) === 0;
      });
    });
  }

  function entriesCell(p) {
    return p.entries
      .slice()
      .sort(function (a, b) { return a.class.localeCompare(b.class); })
      .map(function (e) { return esc(e.class) + ' #' + esc(e.kartNo); })
      .join(' · ');
  }

  function renderPane() {
    var people = filteredPeople();

    if (state.tab === 'byclass') { renderByClass(people); return; }

    var wanted = state.tab === 'missing'
      ? people.filter(function (p) { return !p.checkedIn; })
      : people.filter(function (p) { return p.checkedIn; });

    if (!wanted.length) {
      $('paneBody').innerHTML = '<p class="empty">' +
        (state.tab === 'missing' ? 'Everyone has checked in.' : 'Nobody has checked in yet.') +
        '</p>';
      return;
    }

    var rows = wanted.map(function (p) {
      return '<tr>' +
        '<td>' +
          '<div class="name">' + esc(p.entrant) +
            (p.isJunior ? ' <span class="tag junior">junior</span>' : '') +
          '</div>' +
          '<div class="entries">' + entriesCell(p) + '</div>' +
        '</td>' +
        (state.tab === 'missing'
          ? '<td class="contact">' + esc(p.mobile || '') +
              (p.email ? '<br>' + esc(p.email) : '') + '</td>'
          : '<td class="contact">' + esc(formatTime(p.checkedInAt)) +
              (p.checkinSource === 'admin' ? ' <span class="tag admin">by official</span>' : '') +
              (p.acknowledged ? '' : ' <span class="tag admin">not acknowledged</span>') + '</td>') +
        '<td class="actions no-print">' +
          (state.tab === 'missing'
            ? '<button class="secondary small" data-checkin="' + p.personId + '">Check in</button>'
            : '<button class="danger small" data-undo="' + p.personId + '">Undo</button>') +
        '</td>' +
      '</tr>';
    }).join('');

    $('paneBody').innerHTML =
      '<table class="people"><thead><tr>' +
        '<th>Driver &amp; entries</th>' +
        '<th>' + (state.tab === 'missing' ? 'Contact' : 'Checked in') + '</th>' +
        '<th class="no-print"></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderByClass(people) {
    // expand people back out to per-class entries
    var byClass = new Map();
    people.forEach(function (p) {
      p.entries.forEach(function (e) {
        if (!byClass.has(e.class)) byClass.set(e.class, []);
        byClass.get(e.class).push({
          kartNo: e.kartNo, entrant: p.entrant, checkedIn: p.checkedIn, isJunior: p.isJunior,
        });
      });
    });

    var classes = [...byClass.keys()].sort(function (a, b) { return a.localeCompare(b); });
    if (!classes.length) { $('paneBody').innerHTML = '<p class="empty">Nothing to show.</p>'; return; }

    var toolbar = '<div class="btn-row no-print" style="margin-bottom:14px">' +
      '<button class="secondary small" data-expand-all>Expand all</button>' +
      '<button class="secondary small" data-collapse-all>Collapse all</button>' +
      '<button class="secondary small" data-collapse-complete>Collapse completed</button>' +
    '</div>';

    $('paneBody').innerHTML = toolbar + classes.map(function (c) {
      var list = byClass.get(c).sort(function (a, b) { return kartSort(a.kartNo, b.kartNo); });
      var done = list.filter(function (r) { return r.checkedIn; }).length;
      var missing = list.length - done;
      var collapsed = !!state.collapsed[c];

      return '<div class="class-block' + (collapsed ? ' collapsed' : '') + '">' +
        '<h4 data-toggle-class="' + esc(c) + '" role="button" tabindex="0" ' +
            'aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
          '<span class="caret" aria-hidden="true">&#9662;</span>' +
          '<span class="cls">' + esc(c) + '</span>' +
          '<span class="n">' +
            (missing
              ? '<b style="color:var(--accent)">' + missing + ' missing</b> of ' + list.length
              : '<b style="color:var(--ok)">all ' + list.length + ' in</b>') +
          '</span>' +
        '</h4>' +
        '<ul>' + list.map(function (r) {
          return '<li' + (r.checkedIn ? ' class="done"' : '') + '>' +
            '<span class="k">#' + esc(r.kartNo) + '</span>' +
            '<span>' + esc(r.entrant) + '</span>' +
            (r.checkedIn ? '<span style="margin-left:auto;color:var(--ok)">&#10003;</span>'
                         : '<span style="margin-left:auto;color:var(--accent)">missing</span>') +
          '</li>';
        }).join('') + '</ul>' +
      '</div>';
    }).join('');
  }

  function toggleClass(name) {
    if (state.collapsed[name]) delete state.collapsed[name];
    else state.collapsed[name] = true;
    renderPane();
  }

  /* ---------------------------------------------------------- QR code */

  function renderQr(eventId) {
    var url = checkinUrl(eventId);
    $('qrLink').textContent = url;
    $('qrBox').innerHTML = '';
    if (typeof QRCode === 'undefined') {
      $('qrBox').innerHTML = '<p class="small muted" style="line-height:1.4">QR library did not load.</p>';
      return;
    }
    new QRCode($('qrBox'), {
      text: url,
      width: 400,
      height: 400,
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function qrDataUrl() {
    var canvas = $('qrBox').querySelector('canvas');
    if (canvas) return canvas.toDataURL('image/png');
    var img = $('qrBox').querySelector('img');
    return img ? img.src : '';
  }

  $('copyLinkBtn').addEventListener('click', function () {
    var btn = this;
    navigator.clipboard.writeText($('qrLink').textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy link'; }, 1500);
    });
  });

  $('downloadQrBtn').addEventListener('click', function () {
    var data = qrDataUrl();
    if (!data) return;
    var a = document.createElement('a');
    a.href = data;
    a.download = (state.detail.event.name || 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-checkin-qr.png';
    a.click();
  });

  $('printQrBtn').addEventListener('click', function () {
    var d = state.detail;
    var w = window.open('', '_blank');
    if (!w) return;
    w.document.write(
      '<!doctype html><meta charset="utf-8"><title>Check-in QR</title>' +
      '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:60px 40px;margin:0}' +
      'h1{font-size:40px;margin:0 0 6px}h2{font-size:24px;font-weight:400;color:#475569;margin:0 0 36px}' +
      'img{width:420px;height:420px;image-rendering:pixelated}p{font-size:22px;margin-top:32px}' +
      'small{display:block;color:#64748b;font-size:15px;margin-top:14px;word-break:break-all}</style>' +
      '<h1>' + esc(d.event.name) + '</h1>' +
      '<h2>Driver briefing check-in</h2>' +
      '<img src="' + qrDataUrl() + '">' +
      '<p><b>Scan to check in</b></p>' +
      '<small>' + esc(checkinUrl(d.event.id)) + '</small>'
    );
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 400);
  });

  /* ---------------------------------------------------------- actions */

  $('paneBody').addEventListener('click', function (ev) {
    /* --- By class: collapse / expand --- */
    var head = ev.target.closest('h4[data-toggle-class]');
    if (head) { toggleClass(head.getAttribute('data-toggle-class')); return; }

    if (ev.target.closest('[data-expand-all]')) {
      state.collapsed = {};
      renderPane();
      return;
    }
    if (ev.target.closest('[data-collapse-all]')) {
      state.detail.people.forEach(function (p) {
        p.entries.forEach(function (e) { state.collapsed[e.class] = true; });
      });
      renderPane();
      return;
    }
    if (ev.target.closest('[data-collapse-complete]')) {
      // hide the classes that are fully checked in, keep the ones still missing people
      var total = {}, done = {};
      state.detail.people.forEach(function (p) {
        p.entries.forEach(function (e) {
          total[e.class] = (total[e.class] || 0) + 1;
          if (p.checkedIn) done[e.class] = (done[e.class] || 0) + 1;
        });
      });
      Object.keys(total).forEach(function (c) {
        if ((done[c] || 0) === total[c]) state.collapsed[c] = true;
        else delete state.collapsed[c];
      });
      renderPane();
      return;
    }

    /* --- check in / undo --- */
    var inBtn = ev.target.closest('button[data-checkin]');
    var unBtn = ev.target.closest('button[data-undo]');
    var id = state.detail.event.id;

    if (inBtn) {
      var pid = Number(inBtn.getAttribute('data-checkin'));
      var who = state.detail.people.filter(function (p) { return p.personId === pid; })[0];
      if (!confirm('Check in ' + (who ? who.entrant : 'this driver') + '?\n\n'
        + 'Only do this once they have confirmed they have read the driver '
        + 'briefing notes. It will be recorded as acknowledged by an official.')) return;
      inBtn.disabled = true;
      api('/api/admin/events/' + encodeURIComponent(id) + '/checkin', {
        method: 'POST',
        body: JSON.stringify({ personId: pid }),
      }).then(function () { return loadDetail(id); })
        .catch(function (err) { alert(err.message); inBtn.disabled = false; });
    }

    if (unBtn) {
      var upid = Number(unBtn.getAttribute('data-undo'));
      var person = state.detail.people.filter(function (p) { return p.personId === upid; })[0];
      if (!confirm('Undo the check-in for ' + (person ? person.entrant : 'this driver') + '?')) return;
      unBtn.disabled = true;
      api('/api/admin/events/' + encodeURIComponent(id) + '/checkin/' + upid, { method: 'DELETE' })
        .then(function () { return loadDetail(id); })
        .catch(function (err) { alert(err.message); unBtn.disabled = false; });
    }
  });

  function setTab(tab) {
    state.tab = tab;
    $('tabMissing').setAttribute('aria-selected', String(tab === 'missing'));
    $('tabDone').setAttribute('aria-selected', String(tab === 'done'));
    $('tabByClass').setAttribute('aria-selected', String(tab === 'byclass'));
    renderPane();                                  // switch instantly...
    if (state.detail) loadDetail(state.detail.event.id, true);  // ...then pull fresh data
  }

  // keyboard support for the collapsible class headers
  $('paneBody').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var head = ev.target.closest('h4[data-toggle-class]');
    if (!head) return;
    ev.preventDefault();
    toggleClass(head.getAttribute('data-toggle-class'));
  });

  $('tabMissing').addEventListener('click', function () { setTab('missing'); });
  $('tabDone').addEventListener('click', function () { setTab('done'); });
  $('tabByClass').addEventListener('click', function () { setTab('byclass'); });
  $('peopleSearch').addEventListener('input', renderPane);
  $('backBtn').addEventListener('click', openEvents);
  $('refreshBtn').addEventListener('click', function () { loadDetail(state.detail.event.id); });
  $('printBtn').addEventListener('click', function () { window.print(); });

  /* Auto-refresh is ON by default; the choice is remembered per browser. */

  function autoWanted() {
    try { return localStorage.getItem('ikc_auto_refresh') !== '0'; } catch (e) { return true; }
  }

  function stopAuto() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function startAuto() {
    stopAuto();
    $('autoRefresh').checked = autoWanted();
    if (!autoWanted()) { stampUpdated(); return; }
    state.timer = setInterval(function () {
      if (!state.detail || document.hidden) return;   // don't poll a hidden tab
      loadDetail(state.detail.event.id, true);
    }, REFRESH_MS);
    stampUpdated();
  }

  $('autoRefresh').addEventListener('change', function () {
    try { localStorage.setItem('ikc_auto_refresh', this.checked ? '1' : '0'); } catch (e) { /* ignore */ }
    if (this.checked) {
      startAuto();
      if (state.detail) loadDetail(state.detail.event.id, true);
    } else {
      stopAuto();
      stampUpdated();
    }
  });

  // Catch up immediately when you come back to the tab.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.detail && state.timer) {
      loadDetail(state.detail.event.id, true);
    }
  });

  $('toggleStatusBtn').addEventListener('click', function () {
    var d = state.detail;
    var next = d.event.status === 'open' ? 'closed' : 'open';
    api('/api/admin/events/' + encodeURIComponent(d.event.id), {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    }).then(function () { return loadDetail(d.event.id); })
      .catch(function (err) { alert(err.message); });
  });

  $('deleteBtn').addEventListener('click', function () {
    var d = state.detail;
    if (!confirm('Delete "' + d.event.name + '" and all of its check-ins?\n\nThis cannot be undone.')) return;
    if (!confirm('Really delete? All check-in records for this meeting will be lost.')) return;
    api('/api/admin/events/' + encodeURIComponent(d.event.id), { method: 'DELETE' })
      .then(openEvents)
      .catch(function (err) { alert(err.message); });
  });

  /* ----------------------------------------------------------- export */

  $('exportBtn').addEventListener('click', function () {
    var people = filteredPeople();
    var wanted = state.tab === 'done'
      ? people.filter(function (p) { return p.checkedIn; })
      : state.tab === 'missing'
        ? people.filter(function (p) { return !p.checkedIn; })
        : people;

    var header = ['Entrant', 'CRN', 'Classes', 'Kart numbers', 'Guardian', 'Mobile', 'Email',
      'Checked in', 'Time', 'Checked in by', 'Briefing acknowledged', 'Acknowledgement wording'];
    var lines = [header];

    wanted.forEach(function (p) {
      lines.push([
        p.entrant,
        p.crn || '',
        p.entries.map(function (e) { return e.class; }).join(' | '),
        p.entries.map(function (e) { return e.kartNo; }).join(' | '),
        p.guardian || '',
        p.mobile || '',
        p.email || '',
        p.checkedIn ? 'Yes' : 'No',
        p.checkedInAt ? new Date(p.checkedInAt).toLocaleString('en-AU') : '',
        p.checkedIn ? (p.checkinSource === 'admin' ? 'Official' : 'Driver') : '',
        p.checkedIn ? (p.acknowledged ? 'Yes' : 'No') : '',
        p.ackText || '',
      ]);
    });

    var csv = lines.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');

    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.detail.event.name || 'event').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      + '-' + state.tab + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ------------------------------------------------------------- start */

  (function start() {
    if (!CONFIGURED) {
      show('viewLogin');
      $('loginError').textContent =
        'Not configured yet: set PRODUCTION_API in docs/assets/config.js to your deployed Worker URL.';
      $('loginError').classList.remove('hidden');
      return;
    }
    var saved = '';
    try { saved = sessionStorage.getItem('ikc_admin_key') || ''; } catch (e) { /* ignore */ }
    if (saved) {
      state.key = saved;
      api('/api/admin/ping').then(openEvents).catch(function () { show('viewLogin'); });
    } else {
      show('viewLogin');
    }
  })();
})();
