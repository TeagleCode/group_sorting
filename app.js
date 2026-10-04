/* ==========================================================================
   Group Draw Board
   Sorts tournament teams into two groups with an animated live draw.
   State lives in localStorage, so the pot survives a refresh or a new session.
   ========================================================================== */
'use strict';

(function () {

  var KEY = 'group-draw-board.v1';
  var GROUPS = ['A', 'B'];
  var SAMPLE = ['Lions', 'Eagles', 'Falcons', 'Sharks', 'Wolves', 'Dragons', 'Panthers', 'Comets'];

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var reduced = function () { return matchMedia('(prefers-reduced-motion: reduce)').matches; };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ----------------------------------------------------------- elements -- */

  var el = {
    tourney: $('#tourney'),
    potList: $('#potList'),
    potEmpty: $('#potEmpty'),
    potDone: $('#potDone'),
    potCount: $('#potCount'),
    boards: $('#boards'),
    addForm: $('#addForm'),
    teamInput: $('#teamInput'),
    bulk: $('#bulk'),
    bulkToggle: $('#bulkToggle'),
    bulkInput: $('#bulkInput'),
    drawAllBtn: $('#drawAllBtn'),
    drawAllLabel: $('#drawAllLabel'),
    undoBtn: $('#undoBtn'),
    flight: $('#flight'),
    toasts: $('#toasts'),
    live: $('#live'),
    savedNote: $('#savedNote'),
    printTitle: $('#printTitle'),
    printMeta: $('#printMeta'),
    soundBtn: $('#soundBtn'),
    themeBtn: $('#themeBtn')
  };

  /* -------------------------------------------------------------- state -- */

  function blank() {
    return {
      v: 1,
      title: 'School Football Cup',
      teams: [],
      groups: { A: { name: 'Group A', ids: [] }, B: { name: 'Group B', ids: [] } },
      settings: { sound: true, theme: 'auto' }
    };
  }

  var state = blank();
  var storageOK = true;
  var firstVisit = false;
  var history = [];
  var landing = new Set();   // teams currently in the air
  var flying = 0;
  var drawing = false;
  var stopDraw = false;

  function normalise(raw) {
    var s = blank();
    if (!raw || typeof raw !== 'object') return s;
    if (typeof raw.title === 'string') s.title = raw.title.slice(0, 80);
    var seen = Object.create(null);
    if (Array.isArray(raw.teams)) {
      raw.teams.forEach(function (t) {
        if (!t || typeof t.name !== 'string') return;
        var name = t.name.trim().slice(0, 40);
        if (!name) return;
        var id = typeof t.id === 'string' && t.id && !seen[t.id] ? t.id : uid();
        seen[id] = true;
        s.teams.push({ id: id, name: name });
      });
    }
    var known = Object.create(null);
    s.teams.forEach(function (t) { known[t.id] = true; });
    var placed = Object.create(null);
    GROUPS.forEach(function (g) {
      var src = raw.groups && raw.groups[g] ? raw.groups[g] : null;
      if (src && typeof src.name === 'string' && src.name.trim()) s.groups[g].name = src.name.trim().slice(0, 40);
      var ids = src && Array.isArray(src.ids) ? src.ids : [];
      ids.forEach(function (id) {
        if (known[id] && !placed[id]) { placed[id] = true; s.groups[g].ids.push(id); }
      });
    });
    if (raw.settings) {
      s.settings.sound = raw.settings.sound !== false;
      if (['auto', 'light', 'dark'].indexOf(raw.settings.theme) > -1) s.settings.theme = raw.settings.theme;
    }
    return s;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      firstVisit = !raw;
      state = normalise(raw ? JSON.parse(raw) : null);
    } catch (e) {
      storageOK = false;
      firstVisit = true;
      state = blank();
    }
  }

  var saveTimer = null;
  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        if (storageOK) { storageOK = false; paintSavedNote(); }
      }
    }, 120);
  }

  function snapshot() {
    history.push(JSON.stringify({ teams: state.teams, groups: state.groups }));
    if (history.length > 40) history.shift();
  }

  function undo() {
    var prev = history.pop();
    if (!prev) return;
    try {
      var data = JSON.parse(prev);
      state.teams = data.teams;
      state.groups = data.groups;
    } catch (e) { return; }
    landing.clear();
    render();
    save();
    beep('click');
    toast('Undone');
  }

  /* ------------------------------------------------------------ derived -- */

  function teamById(id) {
    for (var i = 0; i < state.teams.length; i++) if (state.teams[i].id === id) return state.teams[i];
    return null;
  }
  function drawnIds() {
    return state.groups.A.ids.concat(state.groups.B.ids);
  }
  function potTeams() {
    var out = drawnIds(), inGroup = Object.create(null);
    out.forEach(function (id) { inGroup[id] = true; });
    return state.teams.filter(function (t) { return !inGroup[t.id]; });
  }
  function groupOf(id) {
    for (var i = 0; i < GROUPS.length; i++) if (state.groups[GROUPS[i]].ids.indexOf(id) > -1) return GROUPS[i];
    return null;
  }
  function fixtures(n) { return n > 1 ? (n * (n - 1)) / 2 : 0; }

  /* How many teams a single board can hold. Both boards get the same ceiling,
     which is what keeps the two groups within one team of each other. */
  function capacity() { return Math.max(1, Math.ceil(state.teams.length / 2)); }

  /* True while there is still something to draw, in the pot or in the air. */
  function drawInProgress() { return landing.size > 0 || potTeams().length > 0; }

  /* Teams on a board that have actually landed. A team in flight is counted
     nowhere, so no number on screen moves until it drops. */
  function settled(g) {
    return state.groups[g].ids.filter(function (id) { return !landing.has(id); });
  }

  /* Any board with room left is a real possibility, so the draw stays genuinely
     open until one of the two fills up. */
  function pickGroup() {
    var room = GROUPS.filter(function (g) { return state.groups[g].ids.length < capacity(); });
    if (!room.length) {
      room = GROUPS.slice().sort(function (a, b) {
        return state.groups[a].ids.length - state.groups[b].ids.length;
      }).slice(0, 1);
    }
    return room[Math.floor(Math.random() * room.length)];
  }

  /* ------------------------------------------------------------- render -- */

  function icon(id) { return '<svg aria-hidden="true"><use href="#' + id + '"></use></svg>'; }

  function renderPot() {
    var teams = potTeams();
    el.potCount.textContent = teams.length;
    el.potEmpty.hidden = state.teams.length > 0;
    el.potDone.hidden = state.teams.length === 0 || teams.length > 0;
    el.potList.innerHTML = teams.map(function (t, i) {
      var name = esc(t.name);
      return '<li class="pot__row" data-id="' + t.id + '">' +
        '<button class="chip" type="button" data-act="draw" data-id="' + t.id + '" ' +
          'aria-label="Draw ' + name + ' into a group">' +
          '<span class="chip__kit num">' + (i + 1) + '</span>' +
          '<span class="chip__name">' + name + '</span>' +
          '<span class="chip__hint">' + icon('i-arrow-right') + '</span>' +
        '</button>' +
        '<button class="row-tool" type="button" data-act="rename" data-id="' + t.id + '" aria-label="Rename ' + name + '">' + icon('i-pencil') + '</button>' +
        '<button class="row-tool row-tool--del" type="button" data-act="remove" data-id="' + t.id + '" aria-label="Remove ' + name + '">' + icon('i-trash') + '</button>' +
      '</li>';
    }).join('');
  }

  function renderBoards() {
    var open = drawInProgress();
    var waiting = landing.size > 0;
    el.boards.innerHTML = GROUPS.map(function (g) {
      var group = state.groups[g];
      var count = settled(g).length;
      /* While the draw is running both boards show the same number of slots,
         so the layout never twitches to reveal where a team is heading. */
      var slots = open ? Math.max(group.ids.length, capacity()) : Math.max(count, 1);
      var rows = '';
      var marked = false;
      for (var i = 0; i < slots; i++) {
        var id = group.ids[i];
        var body;
        if (id && !landing.has(id)) {
          var t = teamById(id);
          var name = esc(t ? t.name : '');
          body = '<button class="chip chip--drawn" type="button" data-act="return" data-id="' + id + '" ' +
            'aria-label="Send ' + name + ' back to the pot">' +
            '<span class="chip__name">' + name + '</span>' +
            '<span class="chip__hint">' + icon('i-arrow-left') + '</span>' +
          '</button>';
        } else {
          /* Exactly one waiting slot per board, whether or not this is the one
             the ball is actually going to. */
          var wait = waiting && !marked;
          marked = true;
          body = '<div class="slot__blank' + (wait ? ' slot__blank--wait' : '') + '">' +
            (wait ? '?' : 'Open') + '</div>';
        }
        rows += '<li class="slot" data-index="' + i + '">' +
          '<span class="slot__n num">' + (i + 1) + '</span>' +
          '<div class="slot__body">' + body + '</div>' +
        '</li>';
      }
      var fx = fixtures(count);
      return '<section class="panel board' + (waiting ? ' board--wait' : '') + '" data-group="' + g + '" aria-label="' + esc(group.name) + '">' +
        '<div class="board__head">' +
          '<span class="board__letter" aria-hidden="true">' + g + '</span>' +
          '<div class="board__meta">' +
            '<input class="board__name" id="name' + g + '" data-group="' + g + '" value="' + esc(group.name) + '" maxlength="40" aria-label="Name of group ' + g + '">' +
            '<span class="board__fixtures">' + (count ? count + ' team' + (count === 1 ? '' : 's') + ' &middot; ' + fx + ' match' + (fx === 1 ? '' : 'es') : 'No teams yet') + '</span>' +
          '</div>' +
          '<span class="board__count num" aria-hidden="true">' + count + '</span>' +
        '</div>' +
        '<ul class="slots">' + rows + '</ul>' +
      '</section>';
    }).join('');
  }

  function paintSavedNote() {
    el.savedNote.textContent = storageOK
      ? 'Your team list is saved on this device.'
      : 'Heads up: this browser is blocking storage, so the list will not be remembered.';
  }

  function render() {
    renderPot();
    renderBoards();
    el.undoBtn.disabled = history.length === 0;
    el.drawAllBtn.disabled = !drawing && potTeams().length === 0;
    el.printTitle.textContent = state.title || 'Group stage draw';
    el.printMeta.textContent = 'Group stage draw · ' + new Date().toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric'
    });
  }

  /* ---------------------------------------------------------- the maths -- */
  /* The flight path: a lift out of the pot, a shrinking orbit, then a
     slingshot into the waiting slot. Returns position in viewport pixels. */

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function easeOutBack(t) { var c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  /* The ball lifts out of the pot, circles the middle of the screen, drifts
     over one of the boards and hangs there - then, and only then, is the
     destination measured and the strike animated. Nothing in the path depends
     on which group the team is going to. */

  var PH = { lift: 0.16, orbit: 0.62, drift: 0.84 };

  function circlePath(from, feint, opts) {
    var vw = innerWidth, vh = innerHeight, m = 14;
    var w = from.width, h = from.height;
    var S = {
      x: clamp(from.left, m, Math.max(m, vw - w - m)),
      y: clamp(from.top, m, Math.max(m, vh - h - m))
    };

    var base = clamp(Math.min(vw, vh) * 0.2, 58, 170) * (0.88 + Math.random() * 0.26);
    var rx = Math.max(44, Math.min(base, (vw - w) / 2 - m));
    var ry = Math.max(36, Math.min(base * 0.76, (vh - h) / 2 - m));

    /* On a narrow screen a wide chip cannot circle at full size, so it shrinks
       to whatever the orbit leaves room for - it reads as flying further away. */
    var sOrbit = clamp((vw / 2 - m - rx) * 2 / w, 0.5, 1.2);
    var sHover = clamp((vw - 2 * m) / w, sOrbit, 1.26);

    /* Bounds are worked out from the scaled centre of the chip, so a ball that
       grows as it climbs still stays inside the screen. */
    function hold(c, pad, limit) { return clamp(c, pad, Math.max(pad, limit - pad)); }

    /* Centred on the viewport, nudged at random - never towards a board. */
    var O = {
      x: hold(vw / 2 + (Math.random() - 0.5) * vw * 0.1, m + rx + w * sOrbit / 2, vw) - w / 2,
      y: hold(vh * 0.3 + h / 2, m + ry + h * sOrbit / 2, vh) - h / 2
    };

    var F = {
      x: hold(feint.x, m + w * sHover / 2, vw) - w / 2,
      y: hold(feint.y + h / 2, m + h * sHover / 2, vh) - h / 2
    };

    var turns = opts.turns;
    var a0 = Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    var tight = 0.55;
    var P0 = { x: O.x + rx * Math.cos(a0), y: O.y + ry * Math.sin(a0) };
    var P1 = { x: O.x + rx * tight * Math.cos(a0), y: O.y + ry * tight * Math.sin(a0) };
    var rot0 = 16, rot1 = rot0 + 360 * turns, rot2 = rot1 + 46, rot3 = rot2 + 16;

    var fn = function (t) {
      if (t <= PH.lift) {
        var u = easeOutCubic(t / PH.lift);
        return { x: S.x + (P0.x - S.x) * u, y: S.y + (P0.y - S.y) * u, s: 1 + (sOrbit - 1) * u, r: rot0 * u };
      }
      if (t <= PH.orbit) {
        var v = (t - PH.lift) / (PH.orbit - PH.lift);
        var e = easeOutCubic(v);                 /* fast at first, then dawdles */
        var ang = a0 + 2 * Math.PI * turns * e;
        var k = 1 - (1 - tight) * e;
        return {
          x: O.x + rx * k * Math.cos(ang),
          y: O.y + ry * k * Math.sin(ang),
          s: sOrbit * (1 - 0.07 * v),
          r: rot0 + 360 * turns * e
        };
      }
      if (t <= PH.drift) {
        var p = easeInOut((t - PH.orbit) / (PH.drift - PH.orbit));
        return {
          x: P1.x + (F.x - P1.x) * p,
          y: P1.y + (F.y - P1.y) * p,
          s: sOrbit * 0.93 + (sHover - sOrbit * 0.93) * p,
          r: rot1 + (rot2 - rot1) * p
        };
      }
      var q = (t - PH.drift) / (1 - PH.drift);   /* hanging there, breathing */
      return {
        x: F.x + Math.sin(q * Math.PI * 2) * 4,
        y: F.y + Math.sin(q * Math.PI * 3) * 5,
        s: sHover + Math.sin(q * Math.PI * 2) * 0.02,
        r: rot2 + (rot3 - rot2) * q
      };
    };
    fn.end = { x: F.x, y: F.y, s: sHover, r: rot3 };
    fn.turns = turns;
    return fn;
  }

  function dartPath(start, to, turns) {
    var vw = innerWidth, vh = innerHeight, m = 10;
    var D = {
      x: clamp(to.left, -to.width * 0.25, Math.max(0, vw - to.width * 0.75)),
      y: clamp(to.top, m, Math.max(m, vh - to.height - m))
    };
    var endRot = 360 * (turns + 1);              /* lands square in its slot */
    return function (t) {
      var z = easeOutBack(t), e = easeOutCubic(t);
      return {
        x: start.x + (D.x - start.x) * z,
        y: start.y + (D.y - start.y) * z,
        s: start.s + (1 - start.s) * e,
        r: start.r + (endRot - start.r) * e
      };
    };
  }

  function straightPath(from, to) {
    var S = { x: from.left, y: from.top }, D = { x: to.left, y: to.top };
    return function (t) {
      var u = easeOutCubic(t);
      return { x: S.x + (D.x - S.x) * u, y: S.y + (D.y - S.y) * u, s: 1, r: 0 };
    };
  }

  /* Keyframes are interpolated in a straight line, so an evenly spaced sample
     turns the fast part of the orbit into a polygon. Sample by distance
     travelled instead, with a time floor so the slow hover still animates. */
  function keyframes(path, origin) {
    var probe = 2000, step = 9, gap = 0.02;
    var out = [], last = null, lastT = -1;
    for (var i = 0; i <= probe; i++) {
      var t = i / probe;
      var p = path(t);
      var due = !last ||
        Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= step ||
        t - lastT >= gap;
      if (i === 0 || i === probe || due) {
        out.push({
          offset: t,
          transform: 'translate3d(' + (p.x - origin.x).toFixed(2) + 'px,' + (p.y - origin.y).toFixed(2) + 'px,0) ' +
                     'rotate(' + p.r.toFixed(2) + 'deg) scale(' + p.s.toFixed(3) + ')'
        });
        last = p; lastT = t;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- effects -- */

  function addFx(node, anim) {
    el.flight.appendChild(node);
    anim.onfinish = anim.oncancel = function () { node.remove(); };
  }

  function trail(path, anim, duration, group) {
    if (reduced()) return;
    var n = 0;
    (function frame() {
      if (anim.playState === 'finished' || anim.playState === 'idle') return;
      var ct = anim.currentTime;
      if (ct && typeof ct === 'object') ct = ct.value || 0;
      var t = (ct || 0) / duration;
      if (t > 0.04 && t < 0.995 && (n++ % 2 === 0)) {
        var p = path(clamp(t, 0, 1));
        var dot = document.createElement('i');
        dot.className = 'trail';
        if (group) dot.dataset.group = group;
        dot.style.left = (p.x + 16) + 'px';
        dot.style.top = (p.y + 15) + 'px';
        addFx(dot, dot.animate(
          [{ transform: 'scale(1)', opacity: 0.55 }, { transform: 'scale(0.2)', opacity: 0 }],
          { duration: 520, easing: 'ease-out' }
        ));
      }
      requestAnimationFrame(frame);
    })();
  }

  function sparks(rect, group) {
    if (reduced()) return;
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    for (var i = 0; i < 16; i++) {
      var ang = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
      var dist = 34 + Math.random() * 54;
      var dot = document.createElement('i');
      dot.className = 'spark';
      dot.dataset.group = group;
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
      var size = 0.5 + Math.random() * 0.8;
      addFx(dot, dot.animate([
        { transform: 'translate(-50%,-50%) scale(' + size + ')', opacity: 1 },
        { transform: 'translate(calc(-50% + ' + Math.cos(ang) * dist + 'px), calc(-50% + ' + Math.sin(ang) * dist + 'px)) scale(0)', opacity: 0 }
      ], { duration: 520 + Math.random() * 260, easing: 'cubic-bezier(.2,.7,.3,1)' }));
    }
  }

  function ripple(rect, group) {
    if (reduced()) return;
    var r = document.createElement('i');
    r.className = 'ring';
    r.dataset.group = group;
    r.style.left = rect.left + 'px';
    r.style.top = rect.top + 'px';
    r.style.width = rect.width + 'px';
    r.style.height = rect.height + 'px';
    addFx(r, r.animate([
      { transform: 'scale(1)', opacity: 0.9 },
      { transform: 'scale(1.5)', opacity: 0 }
    ], { duration: 620, easing: 'cubic-bezier(.2,.8,.2,1)' }));
  }

  function confetti() {
    if (reduced()) return;
    GROUPS.forEach(function (g) {
      var board = el.boards.querySelector('[data-group="' + g + '"]');
      if (!board) return;
      var r = board.getBoundingClientRect();
      var tint = getComputedStyle(board).getPropertyValue('--accent').trim();
      for (var i = 0; i < 34; i++) {
        var c = document.createElement('i');
        c.className = 'confetti';
        c.style.background = i % 3 === 0 ? 'var(--pitch)' : tint;
        c.style.left = (r.left + Math.random() * r.width) + 'px';
        c.style.top = (r.top + 12) + 'px';
        var dx = (Math.random() - 0.5) * 220;
        var dy = 120 + Math.random() * Math.max(180, r.height);
        addFx(c, c.animate([
          { transform: 'translate3d(0,-20px,0) rotate(0deg)', opacity: 1 },
          { transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) rotate(' + (Math.random() * 900 - 450) + 'deg)', opacity: 0 }
        ], { duration: 1500 + Math.random() * 900, easing: 'cubic-bezier(.2,.5,.5,1)', delay: Math.random() * 320 }));
      }
    });
  }

  /* --------------------------------------------------------------- audio -- */

  var ac = null;
  function actx() {
    if (!state.settings.sound) return null;
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch (e) { return null; }
  }

  var noiseBuf = null;
  function noise(c) {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 0.6, c.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  var droning = false;

  function beep(kind, arg) {
    var c = actx();
    if (!c) return;
    var t = c.currentTime;
    if (kind === 'whoosh') {
      var src = c.createBufferSource(); src.buffer = noise(c);
      var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(320, t);
      bp.frequency.exponentialRampToValueAtTime(2400, t + 0.42);
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.14);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(bp).connect(g).connect(c.destination);
      src.start(t); src.stop(t + 0.55);
    } else if (kind === 'pop') {
      var o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(170, t);
      o.frequency.exponentialRampToValueAtTime(640, t + 0.07);
      var og = c.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(og).connect(c.destination);
      o.start(t); o.stop(t + 0.2);
    } else if (kind === 'click') {
      var k = c.createOscillator(); k.type = 'triangle';
      k.frequency.setValueAtTime(880, t);
      var kg = c.createGain();
      kg.gain.setValueAtTime(0.06, t);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      k.connect(kg).connect(c.destination);
      k.start(t); k.stop(t + 0.08);
    } else if (kind === 'suspense') {
      /* A rising drone that holds under the whole flight and cuts at the drop. */
      if (droning) return;
      droning = true;
      var sec = Math.max(0.6, arg || 2);
      setTimeout(function () { droning = false; }, (sec + 0.1) * 1000);

      var low = c.createOscillator(); low.type = 'sawtooth';
      low.frequency.setValueAtTime(62, t);
      low.frequency.exponentialRampToValueAtTime(186, t + sec);
      var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(260, t);
      lp.frequency.exponentialRampToValueAtTime(1500, t + sec);
      var lg = c.createGain();
      lg.gain.setValueAtTime(0.0001, t);
      lg.gain.exponentialRampToValueAtTime(0.05, t + Math.min(0.6, sec * 0.3));
      lg.gain.exponentialRampToValueAtTime(0.075, t + sec * 0.92);
      lg.gain.exponentialRampToValueAtTime(0.0001, t + sec + 0.08);
      low.connect(lp).connect(lg).connect(c.destination);
      low.start(t); low.stop(t + sec + 0.12);

      var air = c.createBufferSource(); air.buffer = noise(c); air.loop = true;
      var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.6;
      bp.frequency.setValueAtTime(520, t);
      bp.frequency.exponentialRampToValueAtTime(3000, t + sec);
      var ag = c.createGain();
      ag.gain.setValueAtTime(0.0001, t);
      ag.gain.exponentialRampToValueAtTime(0.026, t + sec * 0.85);
      ag.gain.exponentialRampToValueAtTime(0.0001, t + sec + 0.08);
      air.connect(bp).connect(ag).connect(c.destination);
      air.start(t); air.stop(t + sec + 0.12);
    } else if (kind === 'swoop') {
      var sw = c.createBufferSource(); sw.buffer = noise(c);
      var sf = c.createBiquadFilter(); sf.type = 'bandpass'; sf.Q.value = 1.1;
      sf.frequency.setValueAtTime(2600, t);
      sf.frequency.exponentialRampToValueAtTime(420, t + 0.4);
      var sg = c.createGain();
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(0.085, t + 0.08);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      sw.connect(sf).connect(sg).connect(c.destination);
      sw.start(t); sw.stop(t + 0.5);
    } else if (kind === 'reveal') {
      beep('pop');
      [392, 587.33].forEach(function (f, i) {
        var v = c.createOscillator(); v.type = i ? 'triangle' : 'sine';
        v.frequency.setValueAtTime(f, t);
        var vg = c.createGain();
        vg.gain.setValueAtTime(0.0001, t + 0.01);
        vg.gain.exponentialRampToValueAtTime(i ? 0.05 : 0.08, t + 0.03);
        vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
        v.connect(vg).connect(c.destination);
        v.start(t); v.stop(t + 0.38);
      });
    } else if (kind === 'fanfare') {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        var n = c.createOscillator(); n.type = 'sine';
        n.frequency.value = f;
        var ng = c.createGain();
        var at = t + i * 0.1;
        ng.gain.setValueAtTime(0.0001, at);
        ng.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
        ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.65);
        n.connect(ng).connect(c.destination);
        n.start(at); n.stop(at + 0.7);
      });
    }
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  /* ---------------------------------------------------------- the draw --- */

  function announce(msg) { el.live.textContent = msg; }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = msg;
    el.toasts.appendChild(t);
    setTimeout(function () {
      t.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }],
        { duration: 240, easing: 'ease-in' }).onfinish = function () { t.remove(); };
    }, 2300);
  }

  /* Bring the boards into view for the strike. Done at the last moment, after
     the ball has already stopped over a board, so it is part of the reveal
     rather than a hint. */
  function revealScroll(target) {
    var before = window.scrollY;
    var boards = el.boards.getBoundingClientRect();
    if (boards.top < 0 || boards.bottom > innerHeight) window.scrollBy(0, boards.top - 12);
    var t = target.getBoundingClientRect(), edge = 24;
    if (t.bottom > innerHeight - edge) window.scrollBy(0, t.bottom - (innerHeight - edge));
    else if (t.top < edge) window.scrollBy(0, t.top - edge);
    return window.scrollY - before;
  }

  function drawTeam(id, opts) {
    opts = opts || {};
    var team = teamById(id);
    if (!team || groupOf(id)) return Promise.resolve();

    var source = el.potList.querySelector('.chip[data-id="' + id + '"]');
    if (!source) return Promise.resolve();
    var r = source.getBoundingClientRect();
    var from = { left: r.left, top: r.top, width: r.width, height: r.height };
    var kitEl = source.querySelector('.chip__kit');
    var kit = kitEl ? kitEl.textContent : '';

    /* The group is settled here, but the screen says nothing about it: the ball
       flies in the pitch colour, both boards show the same waiting slot, and
       the counts do not move until it lands. */
    var g = opts.group || pickGroup();
    if (!opts.silent) snapshot();
    state.groups[g].ids.push(id);
    landing.add(id);
    flying++;
    render();
    save();

    var board = el.boards.querySelector('[data-group="' + g + '"]');
    var slot = board ? board.querySelectorAll('.slot')[state.groups[g].ids.length - 1] : null;
    var target = slot ? slot.querySelector('.slot__body') : null;

    var flyer = document.createElement('div');
    flyer.className = 'chip flyer';
    flyer.style.left = from.left + 'px';
    flyer.style.top = from.top + 'px';
    flyer.style.width = from.width + 'px';
    flyer.style.height = from.height + 'px';
    flyer.innerHTML = '<span class="chip__kit num">' + esc(kit) + '</span>' +
                      '<span class="chip__name">' + esc(team.name) + '</span>';
    el.flight.appendChild(flyer);

    var origin = { x: from.left, y: from.top };
    var slim = reduced();

    function land() {
      flying = Math.max(0, flying - 1);
      landing.delete(id);
      render();
      flyer.remove();

      announce(team.name + ' drawn into ' + state.groups[g].name);

      var seat = el.boards.querySelector('.chip[data-id="' + id + '"]');
      if (seat) {
        var seatRect = seat.getBoundingClientRect();
        var ratio = clamp(from.width / (seatRect.width || from.width), 0.72, 1.3);
        if (!slim) {
          seat.animate([
            { transform: 'scale(' + ratio + ')', offset: 0 },
            { transform: 'scale(1.09)', offset: 0.45 },
            { transform: 'scale(0.98)', offset: 0.72 },
            { transform: 'scale(1)', offset: 1 }
          ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
        sparks(seatRect, g);
        ripple(seatRect, g);
      }

      var boardNow = el.boards.querySelector('[data-group="' + g + '"]');
      if (boardNow) {
        boardNow.classList.remove('thump');
        void boardNow.offsetWidth;
        boardNow.classList.add('thump');
        var counter = boardNow.querySelector('.board__count');
        if (counter) {
          counter.classList.add('bump');
          setTimeout(function () { counter.classList.remove('bump'); }, 240);
        }
      }

      beep('reveal');
      buzz([18, 40, 26]);

      if (flying === 0 && potTeams().length === 0 && state.teams.length > 1) complete();
    }

    if (slim) {
      if (target) revealScroll(target);
      var to = target ? target.getBoundingClientRect() : from;
      var plain = flyer.animate(keyframes(straightPath(from, to), origin),
        { duration: 260, easing: 'linear', fill: 'forwards' });
      return plain.finished.catch(function () {}).then(land);
    }

    /* The ball hangs over one board or the other before it strikes - sometimes
       the one it is going to, sometimes not. */
    var boardEls = el.boards.querySelectorAll('.board');
    var feintOn = boardEls[Math.floor(Math.random() * boardEls.length)] || board;
    var fr = feintOn
      ? feintOn.getBoundingClientRect()
      : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    var feint = { x: fr.left + fr.width / 2, y: fr.top - from.height - 24 };

    var hold = opts.fast ? 1600 : 2200;
    var strike = opts.fast ? 520 : 600;
    var path = circlePath(from, feint, { turns: opts.fast ? 2 : 3 });

    var circling = flyer.animate(keyframes(path, origin), {
      duration: hold, easing: 'linear', fill: 'forwards'
    });

    beep('suspense', (hold + strike) / 1000);
    trail(path, circling, hold, null);

    return circling.finished.catch(function () {}).then(function () {
      if (target) revealScroll(target);
      var to = target ? target.getBoundingClientRect() : from;
      var dart = dartPath(path.end, to, path.turns);
      flyer.dataset.group = g;                 /* takes the group colour as it dives */
      var hit = flyer.animate(keyframes(dart, origin), {
        duration: strike, easing: 'linear', fill: 'forwards'
      });
      beep('swoop');
      trail(dart, hit, strike, g);
      return hit.finished.catch(function () {});
    }).then(land);
  }

  function complete() {
    var r = el.boards.getBoundingClientRect();
    if (r.top > innerHeight * 0.75 || r.bottom < innerHeight * 0.25) {
      el.boards.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(confetti, 420);
    } else confetti();
    beep('fanfare');
    buzz([12, 50, 16, 50, 24]);
    var a = state.groups.A.ids.length, b = state.groups.B.ids.length;
    toast('<b>Draw complete</b> &middot; ' + a + ' v ' + b + ' &middot; ' + (fixtures(a) + fixtures(b)) + ' matches');
    announce('Draw complete.');
  }

  function returnToPot(id) {
    var g = groupOf(id);
    if (!g || landing.has(id)) return;
    var chip = el.boards.querySelector('.chip[data-id="' + id + '"]');
    var from = chip ? chip.getBoundingClientRect() : null;
    snapshot();
    state.groups[g].ids = state.groups[g].ids.filter(function (x) { return x !== id; });
    render();
    save();
    var team = teamById(id);
    announce((team ? team.name : 'Team') + ' returned to the pot');
    var back = el.potList.querySelector('.chip[data-id="' + id + '"]');
    if (back && from && !reduced()) {
      var to = back.getBoundingClientRect();
      back.animate([
        { transform: 'translate3d(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px,0) scale(1.04)', offset: 0 },
        { transform: 'translate3d(0,0,0) scale(1)', offset: 1 }
      ], { duration: 420, easing: 'cubic-bezier(.3,.9,.2,1)' });
    }
    beep('click');
  }

  async function drawAll() {
    if (drawing) { stopDraw = true; return; }
    var queue = potTeams().map(function (t) { return t.id; });
    if (!queue.length) return;
    drawing = true;
    stopDraw = false;
    el.drawAllLabel.textContent = 'Stop';
    el.drawAllBtn.classList.remove('btn--pitch');
    snapshot();
    for (var i = 0; i < queue.length; i++) {
      if (stopDraw) break;
      drawTeam(queue[i], { fast: true, silent: true });
      if (i < queue.length - 1) await wait(reduced() ? 160 : 1000);
    }
    drawing = false;
    stopDraw = false;
    el.drawAllLabel.textContent = 'Make the draw';
    el.drawAllBtn.classList.add('btn--pitch');
    render();
  }

  /* -------------------------------------------------------- team edits -- */

  function addTeam(name) {
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return false;
    var dupe = state.teams.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); });
    if (dupe) {
      el.teamInput.classList.remove('shake');
      void el.teamInput.offsetWidth;
      el.teamInput.classList.add('shake');
      toast('<b>' + esc(name) + '</b> is already in the list');
      return false;
    }
    snapshot();
    state.teams.push({ id: uid(), name: name });
    render();
    save();
    beep('click');
    return true;
  }

  function addMany(text) {
    var names = String(text || '').split(/[\n,;\t]+/);
    var added = 0, skipped = 0;
    snapshot();
    names.forEach(function (raw) {
      var name = raw.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name) return;
      var dupe = state.teams.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); });
      if (dupe) { skipped++; return; }
      state.teams.push({ id: uid(), name: name });
      added++;
    });
    if (!added) history.pop();
    render();
    save();
    if (added) beep('click');
    toast(added
      ? '<b>' + added + '</b> team' + (added === 1 ? '' : 's') + ' added' + (skipped ? ' &middot; ' + skipped + ' duplicate' + (skipped === 1 ? '' : 's') + ' skipped' : '')
      : 'Nothing new to add');
    return added;
  }

  function removeTeam(id) {
    var t = teamById(id);
    if (!t) return;
    snapshot();
    state.teams = state.teams.filter(function (x) { return x.id !== id; });
    GROUPS.forEach(function (g) {
      state.groups[g].ids = state.groups[g].ids.filter(function (x) { return x !== id; });
    });
    render();
    save();
    toast('Removed <b>' + esc(t.name) + '</b>');
  }

  function startRename(id) {
    var row = el.potList.querySelector('.pot__row[data-id="' + id + '"]');
    var team = teamById(id);
    if (!row || !team) return;
    var chip = row.querySelector('.chip');
    if (!chip) return;
    var input = document.createElement('input');
    input.className = 'rename';
    input.value = team.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', 'New name for ' + team.name);
    chip.replaceWith(input);
    input.focus();
    input.select();
    var done = false;
    function commit(keep) {
      if (done) return;
      done = true;
      var next = input.value.trim().replace(/\s+/g, ' ').slice(0, 40);
      var live = teamById(id);
      if (keep && next && live && next !== live.name) {
        snapshot();
        live.name = next;
        save();
      }
      render();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  function shufflePot() {
    var pot = potTeams();
    if (pot.length < 2) return;
    snapshot();
    var ids = pot.map(function (t) { return t.id; });
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    }
    var order = Object.create(null);
    ids.forEach(function (id, i) { order[id] = i; });
    var drawn = state.teams.filter(function (t) { return groupOf(t.id); });
    var shuffled = pot.slice().sort(function (a, b) { return order[a.id] - order[b.id]; });
    state.teams = drawn.concat(shuffled);
    render();
    save();
    beep('click');
    var rows = el.potList.querySelectorAll('.pot__row');
    if (!reduced()) {
      Array.prototype.forEach.call(rows, function (r, i) {
        r.animate([
          { transform: 'translateX(' + (i % 2 ? 18 : -18) + 'px)', opacity: 0.2 },
          { transform: 'translateX(0)', opacity: 1 }
        ], { duration: 380, delay: i * 22, easing: 'cubic-bezier(.2,.9,.2,1)' });
      });
    }
    toast('Pot shuffled');
  }

  function resetDraw() {
    if (!drawnIds().length) { toast('Nothing drawn yet'); return; }
    snapshot();
    GROUPS.forEach(function (g) { state.groups[g].ids = []; });
    landing.clear();
    render();
    save();
    beep('click');
    toast('Draw reset &middot; everyone is back in the pot');
    announce('Draw reset.');
  }

  function clearAll() {
    if (!state.teams.length) return;
    if (!confirm('Delete all ' + state.teams.length + ' teams and start over?')) return;
    snapshot();
    state.teams = [];
    GROUPS.forEach(function (g) { state.groups[g].ids = []; });
    landing.clear();
    render();
    save();
    toast('Everything cleared');
  }

  function resultText() {
    var lines = [(state.title || 'Group stage draw'), new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), ''];
    GROUPS.forEach(function (g) {
      var group = state.groups[g];
      var n = group.ids.length;
      lines.push(group.name.toUpperCase() + ' (' + n + ' team' + (n === 1 ? '' : 's') + ', ' + fixtures(n) + ' matches)');
      group.ids.forEach(function (id, i) {
        var t = teamById(id);
        lines.push((i + 1) + '. ' + (t ? t.name : ''));
      });
      lines.push('');
    });
    var pot = potTeams();
    if (pot.length) {
      lines.push('STILL IN THE POT');
      pot.forEach(function (t, i) { lines.push((i + 1) + '. ' + t.name); });
    }
    return lines.join('\n').trim();
  }

  function copyResult() {
    var text = resultText();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        toast(ok ? 'Groups copied' : 'Copying is blocked here');
      } catch (e) { toast('Copying is blocked here'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Groups copied'); }, fallback);
    } else fallback();
  }

  /* -------------------------------------------------------------- chrome -- */

  function applyTheme() {
    var t = state.settings.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    el.themeBtn.dataset.state = dark ? 'off' : 'on';
    el.themeBtn.title = 'Theme: ' + t;
    el.themeBtn.setAttribute('aria-label', 'Theme: ' + t + '. Switch theme.');
  }

  function applySound() {
    el.soundBtn.dataset.state = state.settings.sound ? 'on' : 'off';
    el.soundBtn.setAttribute('aria-pressed', String(state.settings.sound));
    el.soundBtn.title = state.settings.sound ? 'Sound on' : 'Sound off';
  }

  /* -------------------------------------------------------------- events -- */

  el.addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (addTeam(el.teamInput.value)) el.teamInput.value = '';
    el.teamInput.focus();
  });

  el.bulkToggle.addEventListener('click', function () {
    var open = el.bulk.hidden;
    el.bulk.hidden = !open;
    el.bulkToggle.setAttribute('aria-expanded', String(open));
    el.bulkToggle.textContent = open ? 'Hide the list box' : 'Paste a whole list';
    if (open) el.bulkInput.focus();
  });

  $('#bulkAdd').addEventListener('click', function () {
    if (addMany(el.bulkInput.value)) {
      el.bulkInput.value = '';
      el.bulk.hidden = true;
      el.bulkToggle.setAttribute('aria-expanded', 'false');
      el.bulkToggle.textContent = 'Paste a whole list';
    }
  });

  $('#bulkCancel').addEventListener('click', function () {
    el.bulk.hidden = true;
    el.bulkToggle.setAttribute('aria-expanded', 'false');
    el.bulkToggle.textContent = 'Paste a whole list';
  });

  el.bulkInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#bulkAdd').click(); }
  });

  $('#sampleBtn').addEventListener('click', function () { addMany(SAMPLE.join('\n')); });

  el.potList.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.dataset.id;
    if (btn.dataset.act === 'draw') drawTeam(id, {});
    else if (btn.dataset.act === 'rename') startRename(id);
    else if (btn.dataset.act === 'remove') removeTeam(id);
  });

  el.boards.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act="return"]');
    if (btn) returnToPot(btn.dataset.id);
  });

  el.boards.addEventListener('input', function (e) {
    var input = e.target.closest('.board__name');
    if (!input) return;
    state.groups[input.dataset.group].name = input.value.slice(0, 40);
    save();
  });

  el.boards.addEventListener('change', function (e) {
    var input = e.target.closest('.board__name');
    if (!input) return;
    var g = input.dataset.group;
    var name = input.value.trim().slice(0, 40) || 'Group ' + g;
    state.groups[g].name = name;
    input.value = name;
    save();
    render();
  });

  el.boards.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.closest('.board__name')) { e.preventDefault(); e.target.blur(); }
  });

  el.tourney.addEventListener('input', function () {
    state.title = el.tourney.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    el.printTitle.textContent = state.title || 'Group stage draw';
    save();
  });
  el.tourney.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); el.tourney.blur(); }
  });
  el.tourney.addEventListener('paste', function (e) {
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text').replace(/\s+/g, ' ').slice(0, 80);
    document.execCommand('insertText', false, text);
  });

  el.drawAllBtn.addEventListener('click', drawAll);
  $('#shuffleBtn').addEventListener('click', shufflePot);
  el.undoBtn.addEventListener('click', undo);
  $('#resetBtn').addEventListener('click', resetDraw);
  $('#clearBtn').addEventListener('click', clearAll);
  $('#copyBtn').addEventListener('click', copyResult);
  $('#printBtn').addEventListener('click', function () { render(); setTimeout(function () { window.print(); }, 60); });

  el.soundBtn.addEventListener('click', function () {
    state.settings.sound = !state.settings.sound;
    applySound();
    save();
    if (state.settings.sound) beep('click');
  });

  el.themeBtn.addEventListener('click', function () {
    var order = ['auto', 'light', 'dark'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % 3];
    applyTheme();
    save();
    toast('Theme: <b>' + state.settings.theme + '</b>');
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
  });

  document.addEventListener('pointerdown', function once() {
    actx();
    document.removeEventListener('pointerdown', once);
  }, { once: true });

  window.addEventListener('storage', function (e) {
    if (e.key !== KEY || drawing || flying) return;
    load();
    applyTheme();
    applySound();
    render();
  });

  /* ---------------------------------------------------------------- boot -- */

  load();

  // A first visit opens with example teams in the pot, so the draw can be
  // tried straight away. Replacing them is one tap on "Clear everything".
  if (firstVisit && !state.teams.length) {
    state.teams = SAMPLE.map(function (name) { return { id: uid(), name: name }; });
    save();
    setTimeout(function () {
      toast('Example teams loaded &middot; clear them when you add your own');
    }, 700);
  }

  el.tourney.textContent = state.title;
  applyTheme();
  applySound();
  paintSavedNote();
  render();

})();
