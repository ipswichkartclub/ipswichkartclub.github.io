/* Driver briefing check-in - public page */
(function () {
  'use strict';

  var RAW = (window.IKC_CONFIG && typeof window.IKC_CONFIG.apiBase === 'string')
    ? window.IKC_CONFIG.apiBase : null;
  // An empty apiBase is valid: it means "same origin" (the local dev server).
  var API = RAW === null ? '' : RAW.replace(/\/+$/, '');
  var CONFIGURED = RAW !== null && API.indexOf('YOUR-SUBDOMAIN') === -1;
  var ACK_TEXT = (window.IKC_CONFIG && window.IKC_CONFIG.ackText)
    || 'I confirm that I have read the driver briefing notes for this meeting.';
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    eventId: null,
    event: null,
    entries: [],
    classes: [],
    selectedClass: '',
    candidate: null,
  };

  /* ------------------------------------------------------------- device */

  function deviceId() {
    var KEY = 'ikc_device_id';
    var id = '';
    try { id = localStorage.getItem(KEY) || ''; } catch (e) { /* private mode */ }
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID()
        : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
      try { localStorage.setItem(KEY, id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  /* -------------------------------------------------------------- views */

  var VIEWS = ['viewLoading', 'viewNoEvent', 'viewClosed', 'viewPicker', 'viewConfirm', 'viewResult'];
  function show(id) {
    VIEWS.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); });
    window.scrollTo(0, 0);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
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

  function entriesText(entries) {
    return (entries || []).map(function (e) {
      return e.class + ' – kart #' + e.kartNo;
    }).join('<br>');
  }

  /* ---------------------------------------------------------------- api */

  function api(path, options) {
    return fetch(API + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
        return body;
      });
    });
  }

  /* ---------------------------------------------------------------- load */

  function load() {
    var params = new URLSearchParams(location.search);
    state.eventId = params.get('e') || params.get('event') || '';

    if (!state.eventId) { show('viewNoEvent'); return; }

    if (!CONFIGURED) {
      $('noEventDetail').textContent =
        'The site is not configured yet: set PRODUCTION_API in docs/assets/config.js to your deployed Worker URL.';
      $('noEventDetail').classList.remove('hidden');
      show('viewNoEvent');
      return;
    }

    api('/api/events/' + encodeURIComponent(state.eventId))
      .then(function (data) {
        state.event = data.event;
        state.entries = data.entries || [];
        state.classes = data.classes || [];

        $('topMeta').textContent = (window.IKC_CONFIG && window.IKC_CONFIG.clubName) || '';
        $('eventName').textContent = state.event.name;
        $('eventDate').textContent = formatDate(state.event.date);
        document.title = state.event.name + ' - Check-in';

        if (state.event.status !== 'open') {
          $('closedDetail').textContent = state.event.name + ' is no longer accepting check-ins.';
          show('viewClosed');
          return;
        }

        buildClassSelect();
        show('viewPicker');
      })
      .catch(function (err) {
        $('noEventDetail').textContent = err.message;
        $('noEventDetail').classList.remove('hidden');
        show('viewNoEvent');
      });
  }

  /** Counts show how many are still TO check in, matching the culled list. */
  function buildClassSelect() {
    var sel = $('classSelect');
    var keep = sel.value;
    sel.innerHTML = '<option value="">Select your class…</option>';
    state.classes.forEach(function (c) {
      var left = remainingIn(c).length;
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = left ? c + ' (' + left + ')' : c + ' — all checked in';
      sel.appendChild(opt);
    });
    if (keep && state.classes.indexOf(keep) !== -1) sel.value = keep;
  }

  /** Pull the roster again so a shared phone sees other people's check-ins. */
  function refreshRoster() {
    return api('/api/events/' + encodeURIComponent(state.eventId))
      .then(function (data) {
        state.entries = data.entries || [];
        state.classes = data.classes || [];
      })
      .catch(function () { /* keep what we already have */ });
  }

  /* ------------------------------------------------------------- picker */

  /** Drivers already checked in are dropped from the list entirely. */
  function remainingIn(cls) {
    return state.entries.filter(function (e) {
      return e.class === cls && !e.checkedIn;
    });
  }

  function renderDrivers() {
    var list = $('driverList');
    var q = $('driverSearch').value.trim().toLowerCase();
    var open = remainingIn(state.selectedClass);

    if (!open.length) {
      list.innerHTML = '<li class="empty">Everyone in ' + esc(state.selectedClass)
        + ' has already checked in.</li>';
      return;
    }

    var rows = open;
    if (q) {
      rows = open.filter(function (e) {
        return e.kartNo.toLowerCase().indexOf(q) !== -1
          || e.entrant.toLowerCase().indexOf(q) !== -1;
      });
    }

    if (!rows.length) {
      list.innerHTML = '<li class="empty">No one left to check in matches &ldquo;'
        + esc(q) + '&rdquo;</li>';
      return;
    }

    list.innerHTML = rows.map(function (e) {
      // other classes this same person is entered in
      var others = state.entries.filter(function (o) {
        return o.personId === e.personId && o.class !== e.class;
      });
      var alsoIn = others.length
        ? '<span class="also-in">Also in ' + esc(others.map(function (o) { return o.class + ' #' + o.kartNo; }).join(', ')) + '</span>'
        : '';
      return '<li><button type="button" data-person="' + e.personId + '">' +
        '<span class="kart-no">' + esc(e.kartNo) + '</span>' +
        '<span class="driver-name">' + esc(e.entrant) + alsoIn + '</span>' +
        '</button></li>';
    }).join('');
  }

  /* ------------------------------------------------------------ confirm */

  function openConfirm(personId) {
    var mine = state.entries.filter(function (e) { return e.personId === personId; });
    if (!mine.length) return;

    state.candidate = { personId: personId, entrant: mine[0].entrant, entries: mine };

    var here = mine.filter(function (e) { return e.class === state.selectedClass; })[0] || mine[0];
    $('confirmWho').textContent = 'Kart #' + here.kartNo + '  ·  ' + here.entrant;
    $('confirmDetail').textContent = here.class;

    if (mine.length > 1) {
      $('confirmCoversList').innerHTML = entriesText(mine);
      $('confirmCovers').classList.remove('hidden');
    } else {
      $('confirmCovers').classList.add('hidden');
    }

    // The acknowledgement is deliberately re-ticked for every driver: a guardian
    // checking in two kids acknowledges once per child, not once per phone.
    $('ackText').textContent = ACK_TEXT;
    $('ackCheck').checked = false;
    $('ackHint').classList.remove('hidden');
    $('confirmError').classList.add('hidden');
    $('confirmBtn').disabled = true;
    $('confirmBtn').textContent = 'Yes, check me in';
    show('viewConfirm');
  }

  function submit() {
    if (!state.candidate || !$('ackCheck').checked) return;
    var btn = $('confirmBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Checking in…';
    $('confirmError').classList.add('hidden');

    api('/api/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: state.eventId,
        personId: state.candidate.personId,
        deviceId: deviceId(),
        acknowledged: true,
        ackText: ACK_TEXT,
      }),
    })
      .then(function (res) { renderResult(res); })
      .catch(function (err) {
        $('confirmError').textContent = err.message;
        $('confirmError').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Yes, check me in';
      });
  }

  /* ------------------------------------------------------------- result */

  function renderResult(res) {
    var box = $('resultBox');
    var covers = $('resultCovers');
    covers.classList.add('hidden');
    box.className = 'result';

    if (res.status === 'ok') {
      box.classList.add('ok');
      $('resultIcon').innerHTML = '&#10003;';
      $('resultTitle').textContent = "You're checked in";
      $('resultWho').textContent = res.person.entrant;
      $('resultDetail').textContent = 'Checked in at ' + formatTime(res.checkedInAt)
        + '. Please make your way to the driver briefing.';
      if (res.person.entries.length > 1) {
        $('resultCoversLabel').textContent = 'This covers all your entries';
        $('resultCoversList').innerHTML = entriesText(res.person.entries);
        covers.classList.remove('hidden');
      }
      markCheckedIn(res.person.personId);

    } else if (res.status === 'already' && res.reason === 'person') {
      box.classList.add('warn');
      $('resultIcon').innerHTML = '&#10003;';
      $('resultTitle').textContent = 'Already checked in';
      $('resultWho').textContent = res.person.entrant;
      $('resultDetail').textContent = res.person.entrant + ' was checked in at '
        + formatTime(res.checkedInAt) + '. Nothing more to do.';
      if (res.person.entries.length > 1) {
        $('resultCoversLabel').textContent = 'Covers these entries';
        $('resultCoversList').innerHTML = entriesText(res.person.entries);
        covers.classList.remove('hidden');
      }
      markCheckedIn(res.person.personId);

    } else if (res.status === 'already' && res.reason === 'guardian') {
      box.classList.add('warn');
      $('resultIcon').innerHTML = '&#9888;';
      $('resultTitle').textContent = 'Different guardian';
      $('resultWho').textContent = res.person.entrant;
      var first = (res.previous || [])[0] || {};
      $('resultDetail').innerHTML =
        'This phone has already been used to check in <b>' + esc(first.entrant || 'another driver')
        + '</b>, who is listed under a different guardian.<br><br>'
        + esc(res.person.entrant) + ' needs to check in from their own guardian&rsquo;s phone. '
        + 'If that is not possible, please see an official at the briefing.';

    } else if (res.status === 'already' && res.reason === 'device') {
      box.classList.add('warn');
      $('resultIcon').innerHTML = '&#9888;';
      $('resultTitle').textContent = 'Already checked in';
      var names = (res.previous || []).map(function (p) { return p.entrant; });
      $('resultWho').textContent = names.join(' and ');
      $('resultDetail').innerHTML = 'This phone has already been used to check in '
        + (names.length === 1 ? 'a driver' : names.length + ' drivers') + '.<br>'
        + 'If ' + esc(res.person.entrant) + ' still needs to check in, please see an official at the briefing.';

    } else if (res.status === 'closed') {
      box.classList.add('warn');
      $('resultIcon').innerHTML = '&#9209;';
      $('resultTitle').textContent = 'Check-in is closed';
      $('resultWho').textContent = '';
      $('resultDetail').textContent = 'This event is no longer accepting check-ins.';
    }

    show('viewResult');
  }

  function markCheckedIn(personId) {
    state.entries.forEach(function (e) {
      if (e.personId === personId) e.checkedIn = true;
    });
  }

  /* ------------------------------------------------------------- events */

  $('classSelect').addEventListener('change', function () {
    state.selectedClass = this.value;
    $('driverSearch').value = '';
    $('driverStep').classList.toggle('hidden', !state.selectedClass);
    if (state.selectedClass) renderDrivers();
  });

  $('driverSearch').addEventListener('input', renderDrivers);

  $('driverList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-person]');
    if (btn) openConfirm(Number(btn.getAttribute('data-person')));
  });

  $('ackCheck').addEventListener('change', function () {
    $('confirmBtn').disabled = !this.checked;
    $('ackHint').classList.toggle('hidden', this.checked);
  });

  $('confirmBtn').addEventListener('click', submit);
  $('confirmBack').addEventListener('click', function () { show('viewPicker'); });
  $('resultDone').addEventListener('click', function () {
    state.candidate = null;
    $('driverSearch').value = '';
    show('viewPicker');
    refreshRoster().then(function () {
      buildClassSelect();
      state.selectedClass = $('classSelect').value;
      $('driverStep').classList.toggle('hidden', !state.selectedClass);
      if (state.selectedClass) renderDrivers();
    });
  });

  load();
})();
