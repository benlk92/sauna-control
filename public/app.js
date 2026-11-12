// Sauna Control front end. No build step, no framework.

const MIN_F = 104;
const MAX_F = 194;
const POLL_MS = 10_000;

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const fmtDay = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
/**
 * sms: link that opens Messages with recipients and text filled in. Several recipients use iOS's
 * sms://open?addresses= form, which starts a group text (works on current iOS, though Apple doesn't
 * document it). Android takes a comma list and ?body=.
 */
function smsHref(numbers, body) {
  const b = encodeURIComponent(body);
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if (numbers.length === 1) return isApple ? `sms:${numbers[0]}&body=${b}` : `sms:${numbers[0]}?body=${b}`;
  return isApple ? `sms://open?addresses=${numbers.join(',')}&body=${b}` : `sms:${numbers.join(',')}?body=${b}`;
}
const deg = (f) => (f == null ? '—' : `${Math.round(f)}°`);
const mins = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login' && path !== '/api/passphrase') {
    owner = false;
    navigate('/login', true);
    throw new Error(data.error || 'Passphrase required');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function sheet({ title, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><p class="muted">${esc(body)}</p>
      <div class="row"><button class="secondary" data-v="0">Cancel</button><button class="${danger ? 'danger' : ''}" data-v="1">${esc(confirm)}</button></div></div>`;
    el.addEventListener('click', (e) => {
      const v = e.target.dataset?.v;
      if (e.target === el || v !== undefined) {
        el.remove();
        resolve(v === '1');
      }
    });
    document.body.append(el);
    el.querySelector('[data-v="1"]').focus();
  });
}

/** The "Gentle Reminders" pop-up after someone puts their name down. */
function remindersSheet(items) {
  if (!items?.length) return Promise.resolve();
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'sheet-backdrop';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="gr-h">
      <h3 id="gr-h">Gentle Reminders</h3>
      <ul class="reminders">${items.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <button data-v="1">Got it</button></div>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.dataset?.v) {
        el.remove();
        resolve();
      }
    });
    document.body.append(el);
    el.querySelector('[data-v]').focus();
  });
}

/** "Now" plus every half hour for the next 8 hours, for "when are you coming?". */
function timeOptions() {
  const step = 30 * 60_000;
  const first = Math.ceil((Date.now() + 10 * 60_000) / step) * step;
  let html = '<option value="">Now</option>';
  for (let t = first; t < Date.now() + 8 * 3600_000; t += step) html += `<option value="${t}">${fmtTime(t)}</option>`;
  return html;
}

// ---------- push ----------

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToU8(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush(role) {
  if (!pushSupported()) throw new Error('This browser can’t receive notifications');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed');
  const { publicKey } = await api('/api/vapid');
  if (!publicKey) throw new Error('Push isn’t set up on the server yet (VAPID keys missing)');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  const r = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), role, name: localStorage.getItem('sauna_name') || undefined } });
  if (role === 'owner' && r.role !== 'owner') throw new Error('Didn’t register as the owner. Sign in on this phone and try again.');
  localStorage.setItem(`sauna_push_${role}`, '1');
  return r;
}

/** Ask the server what this phone is really registered as; forget a stale local "on". */
async function syncPushState(role) {
  if (!localStorage.getItem(`sauna_push_${role}`) || !pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    const { role: actual } = sub ? await api('/api/push/check', { method: 'POST', body: { endpoint: sub.endpoint } }) : { role: null };
    const ok = role === 'owner' ? actual === 'owner' : actual === 'friend' || actual === 'owner';
    if (!ok) localStorage.removeItem(`sauna_push_${role}`);
  } catch {}
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- notification setup (install steps first on iPhone) ----------

const APP_NAME = 'Is it hot yet?';
const ua = navigator.userAgent;
const iosBrowser = () => (/CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : 'Safari');
const pushOn = (role) =>
  !!localStorage.getItem(`sauna_push_${role}`) && 'Notification' in window && Notification.permission === 'granted';

/** on | install | blocked | unsupported | ready */
function pushState(role) {
  if (pushOn(role)) return 'on';
  // iPhone only allows web notifications for sites added to the Home Screen, in every browser.
  if (isIOS && !isStandalone()) return 'install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ready';
}

function installSteps(role) {
  const b = iosBrowser();
  const share =
    b === 'Chrome'
      ? 'Tap the <b>Share</b> button <span aria-hidden="true">⬆︎</span> at the right end of the address bar.'
      : b === 'Safari'
        ? 'Tap the <b>Share</b> button <span aria-hidden="true">⬆︎</span>. It’s in the toolbar, or under the <b>•••</b> button.'
        : `Open ${b}’s menu and tap <b>Share</b>.`;
  const last =
    role === 'owner'
      ? 'Go to <b>☰ → Settings</b> and tap <b>Turn on owner alerts</b>, then <b>Allow</b>.'
      : 'Tap <b>Turn on notifications</b>, then <b>Allow</b>.';
  return `<ol class="steps">
      <li>${share}</li>
      <li>Scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Close ${b} and open <b>${APP_NAME}</b> from your Home Screen.</li>
      <li>${last}</li>
    </ol>
    <p class="small muted" style="margin:0">iPhone only sends web notifications to apps on the Home Screen.</p>`;
}

/** Renders the right notification UI for this phone into `el`, and keeps it current. */
function mountNotify(el, role, onOn) {
  const label = role === 'owner' ? 'Turn on owner alerts' : 'Turn on notifications';
  const render = () => {
    const st = pushState(role);
    el.innerHTML =
      st === 'on'
        ? `<p style="margin:0">Notifications are on for this phone ✓</p>${
            role === 'owner' ? '<button class="secondary small" id="push-test" style="margin-top:12px">Send a test notification</button>' : ''
          }`
        : st === 'install'
          ? `<p><b>First, add ${APP_NAME} to your Home Screen</b></p>${installSteps(role)}`
          : st === 'blocked'
            ? `<p>Notifications are blocked for this app.</p><p class="small muted" style="margin:0">${
                isIOS
                  ? `Open iPhone <b>Settings → Notifications → ${APP_NAME}</b> and turn on <b>Allow Notifications</b>, then come back here.`
                  : 'Tap the icon at the left of the address bar, allow <b>Notifications</b>, then reload this page.'
              }</p>`
            : st === 'unsupported'
              ? '<p style="margin:0">This browser can’t get notifications. Try Chrome or Safari.</p>'
              : `<button id="push-${role}">${label}</button>`;
    $('#push-test', el)?.addEventListener('click', (e) =>
      busy(e.target, async () => {
        const r = await api('/api/push/test', { method: 'POST' });
        toast(r.sent ? `Sent to ${r.sent} owner ${r.sent === 1 ? 'phone' : 'phones'}` : 'No owner phones registered', !r.sent);
      }),
    );
    $(`#push-${role}`, el)?.addEventListener('click', (e) =>
      busy(e.target, async () => {
        await subscribePush(role);
        toast('Notifications on');
      }).then(() => {
        render(); // shows "on", or the blocked help if they tapped Don't Allow
        if (pushState(role) === 'on') onOn?.();
      }),
    );
  };
  render();
  syncPushState(role).then(render);
  return render;
}

// ---------- routing ----------

let owner = false;
let pollTimer = null;
let currentView = null;

const OWNER_ROUTES = { '/control': 'control', '/schedule': 'schedule', '/log': 'log', '/settings': 'settings', '/friends': 'friends' };
// '/status' stays as an alias so links shared before Status became the home page keep working.
const PUBLIC_ROUTES = { '/': 'status', '/status': 'status', '/subscribe': 'subscribe', '/wishlist': 'wishlist', '/login': 'login' };

function navigate(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (a && !a.target && !e.metaKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentView?.refresh) currentView.refresh();
});

async function route() {
  clearInterval(pollTimer);
  closeMenu();
  const path = location.pathname.replace(/\/$/, '') || '/';
  let name = OWNER_ROUTES[path] ?? PUBLIC_ROUTES[path];
  if (!name) return navigate('/', true);
  if (OWNER_ROUTES[path]) {
    if (!owner) owner = (await api('/api/me')).owner;
    if (!owner) return navigate('/login', true);
  }
  const showTabs = !!OWNER_ROUTES[path];
  $('#tabs').hidden = !showTabs;
  document.body.classList.toggle('no-tabs', !showTabs);
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === name);
  $('#stopbar').hidden = true;
  currentView = VIEWS[name]();
  await currentView.refresh?.();
  if (currentView.poll) pollTimer = setInterval(() => document.visibilityState === 'visible' && currentView.refresh(), POLL_MS);
}

// ---------- menu ----------

const menuBtn = $('#menu-btn');
const menu = $('#menu');
const menuBackdrop = $('#menu-backdrop');

function closeMenu() {
  menu.hidden = true;
  menuBackdrop.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

async function openMenu() {
  if (!owner) {
    try {
      owner = (await api('/api/me')).owner;
    } catch {}
  }
  const here = location.pathname.replace(/\/$/, '') || '/';
  const item = (href, label) =>
    `<a href="${href}"${href === here || (href === '/' && here === '/status') ? ' aria-current="page"' : ''}>${label}</a>`;
  menu.innerHTML =
    item('/', 'Status') +
    item('/subscribe', 'Get notified') +
    item('/wishlist', 'Wishlist') +
    '<div class="menu-sep">Owner</div>' +
    (owner
      ? item('/control', 'Control') + item('/schedule', 'Schedule') + item('/log', 'Log') + item('/friends', 'Who gets notifications') + item('/settings', 'Settings') +
        '<button type="button" id="menu-logout">Sign out</button>'
      : item('/login', 'Owner sign-in'));
  menu.hidden = false;
  menuBackdrop.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  menu.querySelector('a, button')?.focus();
}

menuBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
menuBackdrop.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !menu.hidden && (closeMenu(), menuBtn.focus()));
menu.addEventListener('click', async (e) => {
  if (e.target.closest('a')) closeMenu(); // the global link handler does the navigation
  if (e.target.id === 'menu-logout') {
    await api('/api/logout', { method: 'POST' });
    owner = false;
    navigate('/');
  }
});

// Stop bar on owner screens other than Control.
function updateStopbar(s) {
  const active = s && (s.state === 'heating' || s.state === 'hot' || s.state === 'bakeout');
  const bar = $('#stopbar');
  bar.hidden = !active;
  if (active) $('#stopbar-text').textContent = `${s.state === 'bakeout' ? 'Bake-out' : s.state[0].toUpperCase() + s.state.slice(1)} · ${deg(s.currentF)}F`;
}
$('#stopbar-btn').addEventListener('click', (e) =>
  busy(e.target, async () => {
    await api('/api/stop', { method: 'POST' });
    toast('Stopped');
    currentView?.refresh?.();
  }),
);
async function ownerStatusForStopbar() {
  try {
    updateStopbar(await api('/api/status'));
  } catch {}
}

// ---------- dial ----------

function makeDial(el, { value, onInput, onChange }) {
  const R = 120, C = 150, START = 135, SWEEP = 270;
  const toAngle = (f) => START + ((f - MIN_F) / (MAX_F - MIN_F)) * SWEEP;
  const pt = (a, r = R) => [C + r * Math.cos((a * Math.PI) / 180), C + r * Math.sin((a * Math.PI) / 180)];
  const arc = (a0, a1) => {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  el.innerHTML = `<svg viewBox="0 0 300 300" aria-hidden="true">
      <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ffb36b"/><stop offset="1" stop-color="#ff5a2a"/></linearGradient></defs>
      <path d="${arc(START, START + SWEEP)}" stroke="#342016" stroke-width="22" fill="none" stroke-linecap="round"/>
      <path class="val" stroke="url(#g)" stroke-width="22" fill="none" stroke-linecap="round"/>
      <circle class="knob" r="17" fill="#f7ebe1" stroke="#1a0f0b" stroke-width="4"/>
    </svg>
    <div class="dial-center"><div class="dial-target"></div><div class="dial-sub"></div></div>`;
  el.setAttribute('role', 'slider');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', 'Target temperature');
  el.setAttribute('aria-valuemin', MIN_F);
  el.setAttribute('aria-valuemax', MAX_F);
  let v = value;
  let dragging = false;
  const draw = () => {
    const a = toAngle(v);
    $('.val', el).setAttribute('d', arc(START, Math.max(START + 0.01, a)));
    const [x, y] = pt(a);
    $('.knob', el).setAttribute('cx', x);
    $('.knob', el).setAttribute('cy', y);
    $('.dial-target', el).innerHTML = `${v}<sup>°F</sup>`;
    el.setAttribute('aria-valuenow', v);
  };
  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 300 - C;
    const y = ((e.clientY - r.top) / r.height) * 300 - C;
    let a = (Math.atan2(y, x) * 180) / Math.PI;
    if (a < 0) a += 360;
    let rel = a - START;
    if (rel < 0) rel += 360;
    if (rel > SWEEP) rel = rel > SWEEP + (360 - SWEEP) / 2 ? 0 : SWEEP; // dead zone at the bottom snaps to nearest end
    return Math.round(MIN_F + (rel / SWEEP) * (MAX_F - MIN_F));
  };
  const set = (nv, commit) => {
    nv = Math.max(MIN_F, Math.min(MAX_F, nv));
    if (nv !== v) {
      v = nv;
      draw();
      onInput?.(v);
    }
    if (commit) onChange?.(v);
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    set(fromEvent(e));
  });
  el.addEventListener('pointermove', (e) => dragging && set(fromEvent(e)));
  el.addEventListener('pointerup', () => {
    if (dragging) set(v, true);
    dragging = false;
  });
  el.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) {
      e.preventDefault();
      set(v + d, true);
    }
  });
  draw();
  return {
    get value() { return v; },
    get dragging() { return dragging; },
    setValue(nv) { if (!dragging) { v = nv; draw(); } },
    setSub(t) { $('.dial-sub', el).textContent = t; },
  };
}

/** "Alex, Sam (7:30 pm)" — with the time when someone picked one. */
function comersText(s) {
  const list = s.comerList || s.comers.map((name) => ({ name }));
  return list.map((c) => `${esc(c.name)}${c.forAt ? ` <span class="muted">(${fmtTime(c.forAt)})</span>` : ''}`).join(', ');
}

// ---------- graph ----------

function graph(readings, targetF, startedAt, live = true) {
  if (!readings?.length) return '<p class="muted small">The graph fills in as readings arrive.</p>';
  const W = 340, H = 160, P = 6;
  const t0 = startedAt ?? readings[0].t;
  const t1 = Math.max(live ? Date.now() : 0, readings[readings.length - 1].t, t0 + 60_000);
  const fs = readings.map((r) => r.f);
  const lo = Math.floor(Math.min(...fs) / 10) * 10 - 5;
  const hi = Math.max(targetF ?? 0, ...fs) + 8;
  const x = (t) => P + ((t - t0) / (t1 - t0)) * (W - 2 * P);
  const y = (f) => H - P - ((f - lo) / (hi - lo)) * (H - 2 * P);
  const pts = readings.map((r) => `${x(r.t).toFixed(1)},${y(r.f).toFixed(1)}`).join(' ');
  // °F scale: gridlines every 10° (20° for a wide range), labelled in HTML so the stretched SVG doesn't squash the text.
  const step = hi - lo > 60 ? 20 : 10;
  const ticks = [];
  for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) ticks.push(f);
  const grid = ticks.map((f) => `<line x1="0" x2="${W}" y1="${y(f)}" y2="${y(f)}" stroke="#4a2f20" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('');
  const labels = ticks
    .map((f) => `<span class="gl" style="top:${((y(f) / H) * 100).toFixed(1)}%">${f}°</span>`)
    .join('');
  const tgt = targetF ? `<line x1="${P}" x2="${W - P}" y1="${y(targetF)}" y2="${y(targetF)}" stroke="#c3a593" stroke-dasharray="4 5" stroke-width="1" vector-effect="non-scaling-stroke"/>` : '';
  const tgtLabel = targetF ? `<span class="gl tgt" style="top:${((y(targetF) / H) * 100).toFixed(1)}%">${targetF}° target</span>` : '';
  const last = readings[readings.length - 1];
  return `<div class="graph-wrap">${labels}${tgtLabel}<svg class="graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Temperature from ${Math.round(readings[0].f)}°F to ${Math.round(last.f)}°F">
    ${grid}
    <defs><linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a3d" stop-opacity="0.35"/><stop offset="1" stop-color="#ff7a3d" stop-opacity="0"/></linearGradient></defs>
    ${tgt}
    <polygon points="${x(readings[0].t)},${H - P} ${pts} ${x(last.t)},${H - P}" fill="url(#gf)"/>
    <polyline points="${pts}" fill="none" stroke="#ff7a3d" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last.t)}" cy="${y(last.f)}" r="4" fill="#ffb36b"/>
  </svg></div>
  <div class="spread small muted"><span>${fmtTime(t0)}</span><span>${live ? 'now' : fmtTime(t1)}</span></div>`;
}

// ---------- views ----------

const VIEWS = {
  login() {
    app.innerHTML = `<h1>Sauna</h1>
      <form class="card" id="f">
        <label><span>Passphrase</span><input type="password" name="p" autocomplete="current-password" required autofocus></label>
        <button>Unlock</button>
      </form>
      <p class="center"><a href="/">Just checking if it’s hot? See the status page</a></p>`;
    $('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('button', e.target), async () => {
        await api('/api/login', { method: 'POST', body: { passphrase: e.target.p.value } });
        owner = true;
        navigate('/control', true);
      });
    });
    return {};
  },

  control() {
    app.innerHTML = `
      <div class="spread"><h1>Sauna</h1><span class="pill" id="pill">…</span></div>
      <div class="dial-wrap" id="dial"></div>
      <div id="attemp"></div>
      <button id="main" disabled>Start</button>
      <div class="stats" id="stats"></div>
      <div id="hot"></div>
      <div id="bake"></div>
      <div id="alerts"></div>
      <div id="mock"></div>`;
    let s = null;
    let targetTimer;
    let tzSynced = false;
    let userTouchedDial = false;
    const dial = makeDial($('#dial'), {
      value: MAX_F,
      onInput: () => (userTouchedDial = true),
      onChange: (v) => {
        if (s && (s.state === 'heating' || s.state === 'hot')) {
          clearTimeout(targetTimer);
          targetTimer = setTimeout(
            () => busy(null, async () => {
              render(await api('/api/target', { method: 'POST', body: { targetF: v } }));
              toast(`Target ${v}°F`);
            }),
            700,
          );
        }
      },
    });

    $('#main').addEventListener('click', (e) =>
      busy(e.target, async () => {
        if (!s) return;
        if (s.state === 'heating' || s.state === 'hot' || s.state === 'bakeout') {
          render(await api('/api/stop', { method: 'POST' }));
          toast('Stopped');
          return;
        }
        const ok = await sheet({
          title: `Start at ${dial.value}°F for an hour?`,
          body: 'Heater and benches are clear — nothing on or near the heater.',
          confirm: 'Clear — start',
        });
        if (!ok) return;
        render(await api('/api/start', { method: 'POST', body: { targetF: dial.value, clear: true } }));
        toast('Heating');
      }),
    );

    const render = (st) => {
      s = st;
      const active = ['heating', 'hot', 'bakeout'].includes(s.state);
      const pill = $('#pill');
      pill.textContent = s.offline ? 'offline' : s.state === 'bakeout' ? 'bake-out' : s.state;
      pill.className = `pill ${s.state}${s.offline ? ' offline' : ''}`;
      if (s.targetF && !userTouchedDial && s.state !== 'bakeout') dial.setValue(s.targetF);
      dial.setSub(s.currentF != null ? `Now ${deg(s.currentF)}F` : 'Waiting for a reading');

      const main = $('#main');
      main.disabled = false;
      main.textContent = active ? (s.state === 'bakeout' ? 'Stop bake-out' : 'Stop') : 'Start';
      main.className = active ? 'danger' : '';
      if (s.stopPending) main.textContent = 'Stop (retrying…)';

      // Every session is an hour at temperature; this just says when it ends.
      const box = $('#attemp');
      if (active && s.leaving) box.innerHTML = `<p class="small center" style="margin:0 0 12px">Drying out · heater off at <b>${fmtTime(s.endsAt)}</b></p>`;
      else if (active && s.state !== 'bakeout' && s.endsAt) box.innerHTML = `<p class="small center" style="margin:0 0 12px">Ends <b>${fmtTime(s.endsAt)}</b> · an hour at temperature</p>`;
      else box.innerHTML = '';

      const stat = (label, v) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
      let stats;
      if (s.state === 'heating') stats = stat('Now', deg(s.currentF)) + stat('Hot in', s.etaMin != null ? `~${s.etaMin}m` : '—') + stat('Started', fmtTime(s.startedAt));
      else if (s.state === 'hot') stats = stat('Now', deg(s.currentF)) + stat('Time left', mins(s.timeLeftMin)) + stat('Hot since', fmtTime(s.reachedAt));
      else if (s.state === 'bakeout') stats = stat('Now', deg(s.currentF)) + stat('Left', mins(s.bakeoutLeftMin)) + stat('Humidity', s.humidity != null ? `${Math.round(s.humidity)}%` : '—');
      else stats = stat('Now', deg(s.currentF)) + stat('Preheat est.', mins(s.model?.minutes)) + stat('Next', s.schedules?.[0] ? fmtTime(s.schedules[0].hot_by) : '—');
      // The app ends the session; the controller's own 60-min session is the backstop.
      const note = s.durationError
        ? `<span style="color:var(--danger)">The controller didn’t accept the 60-min session, so it may switch off an hour after the heater started.</span>`
        : s.controllerOffAt && active
          ? `Controller backstop: off by <b>${fmtTime(s.controllerOffAt)}</b>${
              s.endsAt && s.controllerOffAt < s.endsAt - 60_000 ? ' — <span style="color:var(--danger)">before your timer</span>' : ''
            }.`
          : '';
      $('#stats').innerHTML = stats + (note ? `<p class="small muted" style="grid-column:1/-1;margin:4px 0 0">${note}</p>` : '');

      // While it's off you can still text whoever asked ("be on in 20", "not tonight"); you finish the message.
      const reqText = s.requestTextList || [];
      const reqBody = `Hey, saw you want a sauna 🔥 `;
      const requestsCard = !active && (s.requests || []).length
        ? `<div class="card"><p style="margin-bottom:6px"><b>Wants a sauna</b></p><ul class="plain small">${s.requests
            .map((r) => `<li>${esc(r.name)} <span class="muted">· ${r.forAt ? `for <b>${fmtTime(r.forAt)}</b>` : `asked ${fmtTime(r.at)}`}</span></li>`)
            .join('')}</ul><p class="small muted" style="margin:8px 0 ${reqText.length ? 12 : 0}px">Start it and they all move to “I’m coming”. The list clears at ${
              s.queueClearsAt ? fmtTime(s.queueClearsAt) : '—'
            } unless someone else asks.</p>${
            reqText.length
              ? `<a class="btn secondary" href="${smsHref(reqText.map((p) => p.phone), reqBody)}">Text ${
                  reqText.length === 1 ? esc(reqText[0].name) : `the ${reqText.length} who left a number`
                }</a>${
                  reqText.length > 1
                    ? `<details style="margin-top:8px"><summary class="small muted">Text one at a time</summary><ul class="plain small">${reqText
                        .map((p) => `<li><a href="${smsHref([p.phone], reqBody)}">Text ${esc(p.name)}</a></li>`)
                        .join('')}</ul></details>`
                    : ''
                }`
              : ''
          }</div>`
        : '';
      // One tap opens Messages with everyone who left a number and the text written; you hit Send.
      const textCard = active && s.state !== 'bakeout' && (s.textList || []).length ? (() => {
        const list = s.textList;
        const body =
          s.state === 'hot'
            ? `Sauna’s hot 🔥 Come on over. ${location.host}`
            : `Sauna’s heating up, should be ready at ${fmtTime(Date.now() + (s.etaMin ?? s.predictedMin ?? 60) * 60_000)}. Let’s melt`;
        const who = list.length === 1 ? list[0].name : `the ${list.length} people who asked`;
        const texted = localStorage.getItem('sauna_texted') === String(s.startedAt);
        return `<div class="card">
          <a class="btn${texted ? ' secondary' : ''}" id="sms-all" href="${smsHref(list.map((p) => p.phone), body)}">${texted ? `Texted ✓ · open again` : `Text ${esc(who)}`}</a>
          <p class="small muted" style="margin:10px 0 0">${list.map((p) => esc(p.name)).join(', ')}${
            (s.comersWithoutPhone || []).length ? ` · no number: ${s.comersWithoutPhone.map(esc).join(', ')}` : ''
          }</p>
          ${list.length > 1 ? `<details style="margin-top:8px"><summary class="small muted">Group text not opening? Text one at a time</summary>
            <ul class="plain small">${list.map((p) => `<li><a href="${smsHref([p.phone], body)}">Text ${esc(p.name)}</a></li>`).join('')}</ul></details>` : ''}
        </div>`;
      })() : '';
      $('#hot').innerHTML = textCard + requestsCard +
        (s.state === 'hot' || s.comers.length
          ? `<div class="card">
              ${s.state === 'hot' ? `<button id="tell">${s.tellSentAt ? `Sent ${fmtTime(s.tellSentAt)}` : 'Tell friends'}</button>` : ''}
              <p class="${s.state === 'hot' ? 'small muted' : 'small'}" style="margin:12px 0 0">${
                s.comers.length ? `<b>${s.comers.length} coming:</b> ${comersText(s)}` : 'Nobody has said they’re coming yet.'
              }</p></div>`
          : '');
      $('#sms-all')?.addEventListener('click', () => localStorage.setItem('sauna_texted', String(s.startedAt)));
      $('#tell')?.addEventListener('click', (e) =>
        busy(e.target, async () => {
          if (s.tellSentAt && !(await sheet({ title: 'Send again?', body: `Already sent at ${fmtTime(s.tellSentAt)}.`, confirm: 'Resend' }))) return;
          const r = await api('/api/tell', { method: 'POST' });
          toast(`Sent to ${r.sent} ${r.sent === 1 ? 'phone' : 'phones'}`);
          refresh();
        }),
      );

      // "I'm leaving": the heater stays on to dry the room, then the app turns it off. Same session, one log row.
      const dry = s.settings.bakeoutMin;
      $('#bake').innerHTML = s.state === 'hot' || s.state === 'heating'
        ? s.leaving
          ? `<div class="card"><p class="small" style="margin:0 0 10px">You’ve left. Heater off at <b>${fmtTime(s.endsAt)}</b>.</p><button class="secondary" id="stay">Actually, I’m staying</button></div>`
          : `<div class="card"><button class="secondary" id="leave">I’m leaving · dry out ${dry} min</button></div>`
        : '';
      $('#leave')?.addEventListener('click', (e) =>
        busy(e.target, async () => {
          const ok = await sheet({ title: 'Heading out?', body: `The heater stays on ${dry} more minutes to dry the room, then turns off. Crack the vents on your way out.`, confirm: 'I’m leaving' });
          if (!ok) return;
          render(await api('/api/leave', { method: 'POST' }));
          toast(`Off in ${dry} min`);
        }),
      );
      $('#stay')?.addEventListener('click', (e) =>
        busy(e.target, async () => {
          render(await api('/api/leave', { method: 'POST', body: { cancel: true } }));
          toast('Staying');
        }),
      );

      $('#alerts').innerHTML = s.alerts?.length
        ? `<div class="spread"><h2>Alerts</h2><button type="button" class="ghost" id="clear-alerts" aria-label="Clear alerts">✕</button></div><div class="card alert"><ul class="plain">${s.alerts
            .slice(0, 4)
            .map((a) => `<li><span class="muted">${fmtTime(a.t)}</span> ${esc(a.text)}</li>`)
            .join('')}</ul></div>`
        : '';

      $('#clear-alerts')?.addEventListener('click', (e) => busy(e.target, async () => render(await api('/api/alerts/clear', { method: 'POST' }))));
      // Push notifications show times in this zone; keep it matched to the owner's phone.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!tzSynced && tz && s.settings.timeZone !== tz) {
        tzSynced = true;
        api('/api/settings', { method: 'POST', body: { timeZone: tz } }).catch(() => {});
      }

      $('#mock').innerHTML = s.mock
        ? `<h2>Simulator</h2><div class="card"><p class="small muted">HARVIA_MOCK is on: this is a simulated controller.</p>
            <div class="row"><button class="secondary small" id="m-off">Drop offline</button><button class="secondary small" id="m-on">Back online</button><button class="secondary small" id="m-tick">Poll now</button></div></div>`
        : '';
      if (s.mock) {
        $('#m-off').onclick = (e) => busy(e.target, () => api('/api/mock/offline', { method: 'POST', body: { offline: true } }).then(() => toast('Controller offline')));
        $('#m-on').onclick = (e) => busy(e.target, () => api('/api/mock/offline', { method: 'POST', body: { offline: false } }).then(() => toast('Controller online')));
        $('#m-tick').onclick = (e) => busy(e.target, async () => render(await api('/api/poke', { method: 'POST' })));
      }
    };
    const refresh = async () => {
      try {
        render(await api('/api/status'));
      } catch (e) {
        toast(e.message, true);
      }
    };
    return { refresh, poll: true };
  },

  schedule() {
    const next7 = new Date();
    next7.setHours(19, 0, 0, 0);
    if (next7.getTime() < Date.now() + 75 * 60_000) next7.setTime(Date.now() + 2 * 3600_000 - (Date.now() % 900_000));
    const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    app.innerHTML = `<h1>Schedule</h1>
      <form class="card" id="f">
        <label><span>Hot by</span><input type="datetime-local" name="hotBy" value="${local(next7)}" required></label>
        <label><span>Target (°F)</span><input type="number" name="targetF" min="${MIN_F}" max="${MAX_F}" step="1" value="${MAX_F}" inputmode="numeric" required></label>
        <p class="small" id="preview">…</p>
        <label class="check"><input type="checkbox" name="clear" required><span class="small">Heater and benches are clear — nobody will be there when it starts</span></label>
        <button>Schedule</button>
      </form>
      <h2>Upcoming</h2><div id="list"></div>`;
    const f = $('#f');
    let previewSeq = 0;
    const preview = async () => {
      const hotBy = new Date(f.hotBy.value).getTime();
      const targetF = Number(f.targetF.value);
      if (!hotBy || !targetF) return;
      const seq = ++previewSeq;
      try {
        const p = await api(`/api/schedule/preview?hotBy=${hotBy}&targetF=${targetF}`);
        if (seq !== previewSeq) return;
        const why = p.method === 'default' ? 'no history yet' : `from ${p.runs} past ${p.runs === 1 ? 'run' : 'runs'}, starting near ${Math.round(p.assumedStartF)}°F`;
        $('#preview').innerHTML = `Starts at <b>${fmtTime(p.startAt)}</b> · preheat ≈ ${mins(p.predictedMin)} (${why}), plus margin.${
          p.startAt < Date.now() ? ' <span style="color:var(--danger)">That’s already past — it would start now.</span>' : ''
        }`;
      } catch {}
    };
    f.addEventListener('input', preview);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('button', f), async () => {
        const r = await api('/api/schedule', {
          method: 'POST',
          body: { hotBy: new Date(f.hotBy.value).getTime(), targetF: Number(f.targetF.value), bakeoutAfter: false, clear: f.clear.checked },
        });
        f.clear.checked = false;
        toast('Scheduled');
        renderList(r);
      });
    });
    const renderList = (s) => {
      updateStopbar(s);
      $('#list').innerHTML = s.schedules.length
        ? `<div class="card"><ul class="plain">${s.schedules
            .map(
              (x) => `<li class="spread"><div><b>${fmtDay(x.hot_by)} ${fmtTime(x.hot_by)}</b> · ${x.target_f}°F${x.bakeout_after ? ' · bake-out' : ''}
                <div class="small muted">Starts ${x.start_at ? fmtTime(x.start_at) : '…'} · preheat ≈ ${mins(x.predicted_min)}</div></div>
                <button class="ghost" data-cancel="${x.id}">Cancel</button></li>`,
            )
            .join('')}</ul></div>`
        : '<p class="muted">Nothing scheduled.</p>';
    };
    $('#list').addEventListener('click', (e) => {
      const id = e.target.dataset.cancel;
      if (id) busy(e.target, async () => renderList(await api(`/api/schedule/${id}`, { method: 'DELETE' })));
    });
    preview();
    return { refresh: async () => renderList(await api('/api/status')), poll: true };
  },

  log() {
    app.innerHTML = `<h1>Log</h1><div id="list"><p class="muted">Loading…</p></div>`;
    const reasons = { manual: 'stopped', max_time: 'timer', left: 'you left', controller: 'controller ended', preheat_cap: 'never got hot', error: 'error' };
    // Calendar week (from Monday), month and year to date, in this phone's time zone.
    const totals = (rows) => {
      const now = new Date();
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const week = new Date(day.getTime() - ((day.getDay() + 6) % 7) * 86400_000);
      const periods = [['This week', week], ['This month', new Date(now.getFullYear(), now.getMonth(), 1)], ['This year', new Date(now.getFullYear(), 0, 1)]];
      return `<div class="stats totals">${periods
        .map(([label, from]) => {
          const rs = rows.filter((r) => r.startedAt >= from.getTime());
          const cost = rs.reduce((a, r) => a + r.cost, 0);
          const est = rs.some((r) => r.elementOnMin == null);
          return `<div class="stat"><b>${est ? '≤ ' : ''}$${cost.toFixed(2)}</b><span>${label} · ${rs.length} ${rs.length === 1 ? 'session' : 'sessions'}</span></div>`;
        })
        .join('')}</div>`;
    };
    return {
      async refresh() {
        ownerStatusForStopbar();
        const rows = await api('/api/log');
        $('#list').innerHTML = rows.length
          ? totals(rows) + rows
              .map(
                (r) => `<div class="card log-row">
            <div class="spread"><b>${fmtDay(r.startedAt)} · ${fmtTime(r.startedAt)}</b><span class="tag">${r.endReason ? reasons[r.endReason] ?? r.endReason : 'running'}${r.actualMin != null && !r.clean ? ' · not used for model' : ''}</span></div>
            <div class="kv">
              <span>Start → target</span><div>${deg(r.startF)} → ${r.targetF}°F</div>
              <span>Preheat (pred / actual)</span><div>${mins(r.predictedMin)} / ${r.actualMin != null ? mins(r.actualMin) : '—'}</div>
              ${r.fxPredictedMin != null ? `<span>Controller’s estimate</span><div>${mins(r.fxPredictedMin)}</div>` : ''}
              <span>Time at temp</span><div>${mins(r.atTempMin)}${r.atTempPlannedMin != null ? ` <span class="muted">of ${mins(r.atTempPlannedMin)}</span>` : ''}</div>
              ${r.dryOutMin != null ? `<span>Dry-out after you left</span><div>${mins(r.dryOutMin)}</div>` : ''}
              <span>Session</span><div>${mins(r.heaterOnMin)}${r.bakeoutMin >= 0.5 ? ` (incl. ${mins(r.bakeoutMin)} bake-out)` : ''}</div>
              ${r.elementOnMin != null
                ? `<span>Element on</span><div>${mins(r.elementOnMin)} <span class="muted">(${Math.round((100 * r.elementOnMin) / Math.max(1, r.heaterOnMin))}%)</span></div>
                   <span>Cost</span><div>$${r.cost.toFixed(2)} <span class="muted">(${r.kwh.toFixed(1)} kWh)</span></div>`
                : `<span>Est. cost</span><div>≤ $${r.cost.toFixed(2)} <span class="muted">(no element data, assumes always on)</span></div>`}
            </div></div>`,
              )
              .join('')
          : '<p class="muted">No sessions yet.</p>';
      },
    };
  },

  settings() {
    app.innerHTML = `<h1>Settings</h1>
      <form class="card" id="f">
        <label><span>Dry-out after “I’m leaving” (min)</span><input type="number" name="bakeoutMin" min="5" max="120" inputmode="numeric"></label>
        <label><span>Electricity rate ($/kWh)</span><input type="number" name="ratePerKwh" min="0" max="5" step="0.01" inputmode="decimal"></label>
        <label><span>Your name (friends see “Benjy got a notification”)</span><input name="ownerName" maxlength="30" autocomplete="off"></label>
        <label><span>Gentle Reminders (one per line, shown after friends put their name down)</span><textarea name="reminders" rows="6"></textarea></label>
        <label><span>Stay signed in for (days)</span><input type="number" name="cookieDays" min="1" max="365" inputmode="numeric"></label>
        <button>Save</button>
      </form>
      <h2>Notifications</h2>
      <div class="card">
        <p id="subs" class="small">…</p>
        <p class="small"><a href="/friends">See who gets notifications →</a></p>
        <p class="small muted">Owner alerts are private: hot, who wants a sauna, who’s coming, and failures.</p>
        <div id="notify"></div>
      </div>
      <h2>Friends link</h2>
      <div class="card"><p class="small"><code id="link"></code></p><button class="secondary" id="copy">Copy link</button></div>
      <h2>Passphrase</h2>
      <form class="card" id="pf">
        <label><span>Current</span><input type="password" name="current" autocomplete="current-password" required></label>
        <label><span>New</span><input type="password" name="next" autocomplete="new-password" minlength="6" required></label>
        <button class="secondary">Change passphrase</button>
        <p class="small muted" style="margin-top:10px">Changing it signs out every other phone.</p>
      </form>
      <button class="ghost" id="logout">Sign out</button>`;
    const link = `${location.origin}/`;
    $('#link').textContent = link;
    $('#copy').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Copied'));
    $('#f').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busy($('button', f), async () => {
        const body = Object.fromEntries(['bakeoutMin', 'ratePerKwh', 'cookieDays'].map((k) => [k, Number(f[k].value)]));
        body.ownerName = f.ownerName.value;
        body.reminders = f.reminders.value.split('\n');
        fill((await api('/api/settings', { method: 'POST', body })).settings);
        toast('Saved');
      });
    });
    $('#pf').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      busy($('button', f), async () => {
        await api('/api/passphrase', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
        f.reset();
        toast('Passphrase changed');
      });
    });
    mountNotify($('#notify'), 'owner');
    $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); owner = false; navigate('/'); };
    const fill = (s) => { for (const [k, v] of Object.entries(s)) if ($('#f')[k]) $('#f')[k].value = Array.isArray(v) ? v.join('\n') : v; };
    const refresh = async () => {
      ownerStatusForStopbar();
      const r = await api('/api/settings');
      fill(r.settings);
      $('#subs').innerHTML = `<b>${r.subscribers}</b> friend ${r.subscribers === 1 ? 'phone' : 'phones'} subscribed · <b>${r.ownerDevices}</b> owner ${r.ownerDevices === 1 ? 'phone' : 'phones'} getting alerts`;
    };
    return { refresh };
  },

  status() {
    app.innerHTML = `<div class="spread"><h1 class="brand">Is it hot yet?</h1><span class="pill" id="pill">…</span></div>
      <div class="center"><div class="big-temp" id="temp">—</div><p class="muted" id="sub"></p></div>
      <div class="card" id="graphcard"><div id="graph"></div></div>
      <div id="coming"></div>
      <p class="center small" id="sublink"><a href="/subscribe">Get notifications when the sauna is hot</a></p>
      <p class="center small"><a href="/wishlist">🎁 Sauna wishlist</a></p>`;
    // Once opened from the Home Screen, offer notifications right here instead of in the menu.
    const st = pushState('friend');
    if (st === 'on') $('#sublink').innerHTML = '<span class="muted">You’ll get a notification when it’s hot.</span>';
    else if (isStandalone() && st !== 'unsupported' && !localStorage.getItem('sauna_push_owner')) {
      $('#sublink').hidden = true;
      const box = document.createElement('div');
      box.className = 'card';
      box.innerHTML = '<p style="margin-bottom:10px"><b>Get notifications when the sauna is hot?</b></p><div></div>';
      $('#graphcard').before(box);
      mountNotify($('div', box), 'friend', () => setTimeout(() => box.remove(), 1500));
    }
    let s;
    const clientId = localStorage.getItem('sauna_client') || (crypto.randomUUID?.() ?? String(Math.random()).slice(2));
    localStorage.setItem('sauna_client', clientId);

    // Optional second step after "I wanna sauna": leave a number to get a text if it's turned on.
    const phoneBlock = (owner) =>
      s.yourPhone
        ? `<p class="small">📱 ${esc(owner)} will text you at ${esc(s.yourPhone)} if it’s turned on.
             <button type="button" class="ghost small" id="ph-remove" style="padding:4px 6px">Remove</button></p>`
        : `<form id="pf" style="margin-bottom:14px"><label style="margin-bottom:8px"><span>Want a text if it’s turned on? (optional)</span>
             <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(415) 555-0123" value="${esc(localStorage.getItem('sauna_phone') || '')}"></label>
             <button>Text me</button></form>`;

    const render = () => {
      const on = s.state === 'heating' || s.state === 'hot';
      $('#pill').textContent = s.offline ? 'offline' : s.state === 'bakeout' ? 'drying' : s.state;
      $('#pill').className = `pill ${s.state}${s.offline ? ' offline' : ''}`;
      $('#temp').innerHTML = s.currentF != null ? `${Math.round(s.currentF)}<sup>°F</sup>` : '—';
      $('#sub').textContent =
        s.state === 'heating' ? `Heating to ${s.targetF}°F · ${s.etaMin > 1 ? `hot in about ${s.etaMin} min` : 'almost hot'}`
        : s.wrappingUpAt ? `Wrapping up · heater off at ${fmtTime(s.wrappingUpAt)}`
        : s.state === 'hot' ? `Hot · target ${s.targetF}°F`
        : s.state === 'cooling' ? 'Cooling down'
        : s.state === 'bakeout' ? 'Drying out after a session'
        : 'The sauna is off.';
      // Always live: the past hour, whether or not it's on.
      const g = s.graph;
      $('#graphcard').hidden = false;
      $('#graph').innerHTML = `<p class="small muted" style="margin:0 0 6px">Past hour</p>` +
        graph(s.readings, g?.targetF ?? null, g?.from ?? Date.now() - 3600_000, true);

      const name = localStorage.getItem('sauna_name') || '';
      const owner = s.ownerName || 'Benjy';
      // Two states: while it's on, "I'm coming"; otherwise "I wanna sauna" (a request), which becomes
      // "I'm coming" if the owner starts it within an hour of the request.
      // Name (once) and an optional time, defaulting to now. The phone number comes after, as a second step.
      const form = (label, cls = '') => `
        <form id="cf">${name ? '' : '<label><span>Your name</span><input name="name" autocomplete="given-name" maxlength="40" required></label>'}
        <label><span>When?</span><select name="when">${timeOptions()}</select></label>
        <button class="${cls}">${label}${name ? ` (${esc(name)})` : ''}</button></form>`;
      const comersLine = s.comers.length ? `<p><b>${s.comers.length} coming:</b> ${comersText(s)}</p>` : '';
      let card;
      if (on) {
        card = `${comersLine || '<p class="muted">Nobody’s said they’re coming yet.</p>'}
          ${s.youreComing ? '<p class="small muted" style="margin:0">You’re on the list.</p>' : form('I’m coming')}`;
      } else {
        // Same prompt and form for everyone; whoever's already asked is listed underneath.
        const list = (s.requests || []).length
          ? `<div class="wants"><p class="small" style="margin-bottom:4px"><b>Here’s who wants to sauna:</b></p>
             <ul class="plain small">${s.requests
               .map((r) => `<li>${esc(r.name)} <span class="muted">· ${r.forAt ? `for ${fmtTime(r.forAt)}` : `asked ${fmtTime(r.at)}`}</span></li>`)
               .join('')}</ul></div>`
          : '';
        // After a session the list lingers until the room cools below 130°F; label it as past.
        const pastLine = s.comers.length ? `<p class="small muted" style="margin:14px 0 0">Last session: ${comersText(s)}</p>` : '';
        card = s.youAskedAt
          ? `<p>${esc(owner)}’s on it, but no promises. Make sure it’s hot before you come over.</p>
             ${phoneBlock(owner)}${form('Ask again', 'secondary')}${list}${pastLine}`
          : `<p class="muted">The sauna’s off. Feel like one? Let ${esc(owner)} know.</p>
             ${form('I wanna sauna')}${list}${pastLine}`;
      }
      // Don't redraw under someone who's typing or picking a time (Status refreshes every 10 s).
      const box = $('#coming');
      if (box.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
      box.innerHTML = `<div class="card">${card}</div>`;
      $('#pf')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = e.target.phone.value.trim();
        if (!raw) return;
        busy($('button', e.target), async () => {
          await api('/api/public/phone', { method: 'POST', body: { clientId, phone: raw } });
          localStorage.setItem('sauna_phone', raw);
          toast(`${owner} will text you if it’s turned on`);
          document.activeElement?.blur();
          refresh();
        });
      });
      $('#ph-remove')?.addEventListener('click', (e) =>
        busy(e.target, async () => {
          await api('/api/public/phone', { method: 'POST', body: { clientId, phone: null } });
          localStorage.removeItem('sauna_phone');
          toast('Number removed');
          refresh();
        }),
      );
      $('#cf')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const n = e.target.name?.value?.trim() || name;
        const forAt = Number(e.target.when?.value) || null;
        busy($('button', e.target), async () => {
          // A number they gave before rides along, so they only ever type it once.
          const phone = localStorage.getItem('sauna_phone') || undefined;
          const r = await api('/api/public/coming', { method: 'POST', body: { clientId, name: n, phone, forAt } });
          localStorage.setItem('sauna_name', n);
          document.activeElement?.blur();
          toast(r.kind === 'request' ? `${s.ownerName || 'Benjy'}’s on it` : 'See you there');
          await refresh();
          await remindersSheet(s.reminders);
        });
      });
    };
    const refresh = async () => {
      try {
        s = await api(`/api/public/status?client=${encodeURIComponent(clientId)}`);
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
    return { refresh, poll: true };
  },

  friends() {
    app.innerHTML = `<h1>Who gets notifications</h1>
      <p class="muted small">Phones that get a notification when you tap “Tell friends”. Removing one stops it; they can sign up again from Status.</p>
      <div id="list"><p class="muted">Loading…</p></div>`;
    const draw = (rows) => {
      const friends = rows.filter((r) => r.role === 'friend');
      const owners = rows.filter((r) => r.role === 'owner');
      const row = (r) => `<li><div><b>${r.name ? esc(r.name) : '<span class="muted">No name given</span>'}</b>
          <div class="small muted">${esc(r.kind)} · since ${fmtDay(r.since)}</div></div>
          <button type="button" class="ghost small" data-ep="${esc(r.endpoint)}">Remove</button></li>`;
      $('#list').innerHTML =
        `<div class="card"><ul class="plain wish">${friends.length ? friends.map(row).join('') : '<li class="muted">No friends signed up yet.</li>'}</ul></div>` +
        (owners.length ? `<h2>Your owner alerts</h2><div class="card"><ul class="plain wish">${owners.map(row).join('')}</ul></div>` : '');
    };
    $('#list').addEventListener('click', (e) => {
      const ep = e.target.dataset?.ep;
      if (!ep) return;
      busy(e.target, async () => {
        if (!(await sheet({ title: 'Remove this phone?', body: 'It stops getting sauna notifications.', confirm: 'Remove', danger: true }))) return;
        draw(await api('/api/subscribers/remove', { method: 'POST', body: { endpoint: ep } }));
        toast('Removed');
      });
    });
    return {
      async refresh() {
        ownerStatusForStopbar();
        draw(await api('/api/subscribers'));
      },
    };
  },

  wishlist() {
    app.innerHTML = `<h1>Sauna wishlist</h1>
      <p class="muted" id="intro">No need to chip in for sessions. If you’d like to say thanks, here’s what the sauna could use.</p>
      <div id="list"><p class="muted">Loading…</p></div>
      <div id="add"></div>
      <p class="center"><a href="/">Back to status</a></p>`;
    let isOwner = owner;
    const draw = (items) => {
      $('#list').innerHTML = items.length
        ? `<div class="card"><ul class="plain wish">${items
            .map(
              (i) => `<li><span>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.title)} ↗</a>` : esc(i.title)}</span>${
                isOwner ? `<button type="button" class="ghost small" data-del="${i.id}" aria-label="Remove ${esc(i.title)}">Remove</button>` : ''
              }</li>`,
            )
            .join('')}</ul></div>`
        : `<p class="muted">${isOwner ? 'Nothing on the list yet. Add something below.' : 'Nothing on the list right now.'}</p>`;
    };
    $('#list').addEventListener('click', (e) => {
      const id = e.target.dataset?.del;
      if (id) busy(e.target, async () => { draw(await api(`/api/wishlist/${id}`, { method: 'DELETE' })); toast('Removed'); });
    });
    const showAdd = () => {
      $('#add').innerHTML = `<h2>Add an item</h2><form class="card" id="wf">
          <label><span>Item</span><input name="title" maxlength="120" required placeholder="Cedar bucket and ladle"></label>
          <label><span>Link (optional)</span><input name="url" type="url" inputmode="url" placeholder="https://…"></label>
          <button>Add to wishlist</button></form>`;
      $('#wf').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target;
        busy($('button', f), async () => {
          draw(await api('/api/wishlist', { method: 'POST', body: { title: f.title.value, url: f.url.value } }));
          f.reset();
          toast('Added');
        });
      });
    };
    return {
      async refresh() {
        if (!isOwner) isOwner = owner = (await api('/api/me').catch(() => ({ owner: false }))).owner;
        draw(await api('/api/public/wishlist'));
        if (isOwner && !$('#wf')) showAdd();
      },
    };
  },

  subscribe() {
    app.innerHTML = `<h1>Get notified</h1>
      <p class="muted">You’ll get a notification when <span id="who">Benjy</span> says the sauna’s hot. Nothing else.</p>
      <label id="nm"><span>Your name (so ${'${'}'Benjy'} knows who’s subscribed)</span><input name="name" autocomplete="given-name" maxlength="40"></label>
      <div class="card" id="notify"></div>
      <p class="center"><a href="/">Back to status</a></p>`;
    const nameInput = $('#nm input');
    nameInput.value = localStorage.getItem('sauna_name') || '';
    nameInput.addEventListener('input', () => localStorage.setItem('sauna_name', nameInput.value.trim()));
    mountNotify($('#notify'), 'friend');
    api('/api/public/status')
      .then((s) => {
        if (!s.ownerName) return;
        $('#who').textContent = s.ownerName;
        $('#nm span').textContent = `Your name (so ${s.ownerName} knows who’s subscribed)`;
      })
      .catch(() => {});
    return {};
  },
};

route();
