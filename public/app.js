'use strict';
// Dashboard. All user-provided text is written with textContent / .value, never innerHTML.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let state = { user: null, collections: [], works: [] };
let signupMode = true;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
}

async function api(method, url, body, raw) {
  const opts = { method, headers: { 'X-Requested-With': 'artfolio' }, credentials: 'same-origin' };
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ================= auth =================
function renderAuthMode() {
  const f = $('#auth-form');
  $('#auth-title').textContent = signupMode ? 'Create your portfolio' : 'Welcome back';
  $('#auth-submit').textContent = signupMode ? "Sign up, it's free" : 'Log in';
  $('#auth-switch-text').textContent = signupMode ? 'Already have an account?' : 'New here?';
  $('#auth-switch').textContent = signupMode ? 'Log in' : 'Sign up';
  $('#username-label').replaceChildren(
    ...(signupMode ? ['Username ', el('small', { textContent: '(your page will be at /u/username)' })] : ['Username or email'])
  );
  f.password.autocomplete = signupMode ? 'new-password' : 'current-password';
  f.password.minLength = signupMode ? 10 : 0;
  f.email.required = signupMode;
  $('#email-row').hidden = !signupMode;
  $('#auth-error').textContent = '';
  $('#forgot-row').hidden = signupMode;
}
$('#auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  renderAuthMode();
});
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (signupMode && !/^[A-Za-z0-9_-]{3,30}$/.test(f.username.value.trim())) {
    $('#auth-error').textContent = 'Username must be 3-30 letters, numbers, - or _';
    return;
  }
  $('#auth-submit').disabled = true;
  try {
    const body = { username: f.username.value.trim(), password: f.password.value };
    if (signupMode) body.email = f.email.value.trim();
    await api('POST', signupMode ? '/api/signup' : '/api/login', body);
    f.password.value = '';
    await load();
    if (signupMode && state.user) toast('Welcome! We emailed you a code to confirm your address.', 5000);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

// ----- forgot password: email a one-time code, then code + new password -----
let recoverStep = 1;
function showRecover(step, { email = '', code = '' } = {}) {
  const f = $('#recover-form');
  recoverStep = step;
  $('#auth-form').hidden = true;
  f.hidden = false;
  if (email) f.email.value = email;
  if (code) f.code.value = code;
  $('#recover-step1').hidden = step !== 1;
  $('#recover-step2').hidden = step !== 2;
  $('#recover-again').hidden = step !== 2;
  $('#recover-submit').textContent = step === 1 ? 'Email me a code' : 'Set new password';
  $('#recover-sent').textContent = step === 2 ? `If ${f.email.value || 'that address'} belongs to an account, a code is on its way. It works for 20 minutes. Check your spam folder too.` : '';
  $('#recover-error').textContent = '';
  (step === 1 ? f.email : code ? f.password : f.code).focus();
}
$('#forgot').addEventListener('click', (e) => {
  e.preventDefault();
  const typed = $('#auth-form').username.value.trim();
  showRecover(1, { email: typed.includes('@') ? typed : '' });
});
$('#recover-again').addEventListener('click', (e) => {
  e.preventDefault();
  showRecover(1);
});
$('#recover-back').addEventListener('click', (e) => {
  e.preventDefault();
  $('#recover-form').hidden = true;
  $('#auth-form').hidden = false;
});
$('#recover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#recover-error').textContent = '';
  $('#recover-submit').disabled = true;
  try {
    if (recoverStep === 1) {
      await api('POST', '/api/password-reset/request', { email: f.email.value.trim() });
      showRecover(2);
    } else {
      await api('POST', '/api/password-reset/confirm', { email: f.email.value.trim(), code: f.code.value, newPassword: f.password.value });
      f.reset();
      $('#recover-form').hidden = true;
      $('#auth-form').hidden = false;
      await load();
      toast('Password changed. You are signed in.', 4000);
    }
  } catch (err) {
    $('#recover-error').textContent = err.message;
  } finally {
    $('#recover-submit').disabled = false;
  }
});

// Links in our emails: /#reset?email=...&code=...  and  /#verify=CODE
function handleEmailLink() {
  const h = location.hash;
  if (!h.startsWith('#reset') && !h.startsWith('#verify')) return null;
  history.replaceState(null, '', location.pathname + location.search); // don't leave the code in the address bar
  if (h.startsWith('#reset')) {
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    return { reset: { email: q.get('email') || '', code: q.get('code') || '' } };
  }
  return { verify: decodeURIComponent(h.slice('#verify='.length)) };
}

$('#logout').addEventListener('click', async () => {
  try {
    await api('POST', '/api/logout');
  } catch (err) {
    return toast(err.message);
  }
  state = { user: null, collections: [], works: [] };
  show();
});

// ================= load / show =================
async function load() {
  try {
    state = await api('GET', '/api/me');
  } catch (err) {
    if (err.status !== 401) toast(err.message);
    state = { user: null, collections: [], works: [] };
  }
  show();
}
async function start() {
  const link = handleEmailLink();
  await load();
  if (link?.reset && !state.user) showRecover(2, link.reset);
  else if (link?.reset) toast('You are already signed in. Change your password in the Account tab.', 5000);
  if (link?.verify) {
    if (!state.user) {
      signupMode = false;
      renderAuthMode();
      $('#auth-error').textContent = 'Log in to confirm your email. The code is in the email we sent.';
      pendingVerify = link.verify;
    } else await verifyEmail(link.verify);
  }
}
let pendingVerify = null;
// An email link opened in a tab where Artfolio is already loaded only changes the #fragment: handle that too.
window.addEventListener('hashchange', async () => {
  const link = handleEmailLink();
  if (link?.reset) {
    if (state.user) toast('You are already signed in. Change your password in the Account tab.', 5000);
    else showRecover(2, link.reset);
  }
  if (link?.verify) {
    if (state.user) await verifyEmail(link.verify);
    else {
      pendingVerify = link.verify;
      signupMode = false;
      renderAuthMode();
      $('#auth-error').textContent = 'Log in to confirm your email. The code is in the email we sent.';
    }
  }
});

function show() {
  const authed = !!state.user;
  $('#auth').hidden = authed;
  $('#app').hidden = !authed;
  if (!authed) return renderAuthMode();
  const link = `${location.origin}/u/${state.user.username}`;
  $('#view-link').href = `/u/${state.user.username}`;
  $('#preview-open').href = `/u/${state.user.username}`;
  loadPreview();
  $('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(state.user.published ? 'Link copied' : 'Link copied. Your site is still a draft, so publish it for others to see it.', 4000);
    } catch {
      toast(link, 5000);
    }
  };
  fillProfileForm();
  buildDials();
  renderPublish();
  renderEmail();
  renderCollections();
  renderWorks();
  switchTab('works');
  if (pendingVerify) {
    const code = pendingVerify;
    pendingVerify = null;
    verifyEmail(code);
  }
}

// ================= tabs =================
function switchTab(name) {
  for (const t of $$('.tabs [role=tab]')) {
    const on = t.id === `tab-${name}`;
    t.setAttribute('aria-selected', String(on));
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  $('main.wrap').classList.toggle('full', name === 'works');
  if (name === 'account') loadAccountInfo();
}
$$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.id.replace('tab-', ''))));

// ================= profile =================
const PROFILE_FIELDS = ['displayName', 'bio', 'website', 'instagram', 'contactEmail'];
function fillProfileForm() {
  const f = $('#profile-form');
  PROFILE_FIELDS.forEach((k) => (f[k].value = state.user[k] || ''));
  $('#profile-error').textContent = '';
}
async function saveProfile(patch) {
  const r = await api('PATCH', '/api/profile', patch);
  state.user = { ...r.user, ...pendingLook }; // keep any look change made while this request was in flight
  return r;
}
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#profile-error').textContent = '';
  try {
    await saveProfile(Object.fromEntries(PROFILE_FIELDS.map((k) => [k, f[k].value])));
    fillProfileForm();
    reloadPreview();
    toast('Profile saved');
  } catch (err) {
    $('#profile-error').textContent = err.message;
  }
});

// ================= look: dot sliders + live preview =================
const LAYOUTS = [
  { value: 'gallery', label: 'Gallery', desc: 'A masonry wall that fits every shape of work.' },
  { value: 'grid', label: 'Grid', desc: 'Even square tiles. Titles appear on hover.' },
  { value: 'editorial', label: 'Editorial', desc: 'One large piece at a time, with room for the story.' },
  { value: 'studio', label: 'Studio', desc: 'Your info stays in a sidebar while the work scrolls.' },
  { value: 'carousel', label: 'Carousel ✦', pro: true, desc: 'Upgraded: pieces spin around in 3D. Drag, swipe, or use the arrow keys.' },
  { value: 'spotlight', label: 'Spotlight ✦', pro: true, desc: 'Upgraded: full-screen, one piece per scroll, with a slow reveal.' },
];
const PALETTES = [
  { value: 'chalk', label: 'Chalk', colors: ['#f5f5f3', '#141414'] },
  { value: 'ink', label: 'Ink', colors: ['#0b0c0e', '#ececea'] },
  { value: 'sage', label: 'Sage', colors: ['#e6eae2', '#3e5c47'] },
  { value: 'midnight', label: 'Midnight', colors: ['#101a30', '#e2b867'] },
];

// A single bar with one dot per option. Click a dot, drag the knob, or use the arrow keys.
function makeDial(root, items, value, onPick) {
  root.replaceChildren();
  root._listeners?.abort(); // the dial is rebuilt on every sign-in: drop the previous build's listeners
  root._listeners = new AbortController();
  const { signal } = root._listeners;
  const n = items.length;
  const pct = (i) => `${(i / (n - 1)) * 100}%`;
  const fill = el('div', { className: 'dial-fill' });
  const track = el('div', { className: 'dial-track' }, fill);
  const thumb = el('div', { className: 'dial-thumb' });
  root.append(track, thumb);
  const inputs = [], stops = [];
  let cur = -1;

  function select(i, notify = true) {
    if (i === cur) return;
    cur = i;
    inputs.forEach((inp, k) => (inp.checked = k === i));
    stops.forEach((st, k) => st.classList.toggle('on', k === i));
    thumb.style.left = fill.style.width = pct(i);
    root.classList.toggle('on-pro', !!items[i].pro);
    if (notify) onPick(items[i], i);
  }
  items.forEach((it, i) => {
    const input = el('input', { type: 'radio', name: root.id, value: it.value });
    input.addEventListener('change', () => select(i));
    const dot = el('span', { className: 'dot' });
    const stop = el('label', { className: 'dial-stop' + (it.pro ? ' pro' : '') + (it.colors ? ' color' : '') }, input, dot, el('span', { className: 'lbl', textContent: it.label }));
    if (it.colors) {
      stop.style.setProperty('--c1', it.colors[0]);
      stop.style.setProperty('--c2', it.colors[1]);
    }
    stop.style.left = pct(i);
    inputs.push(input);
    stops.push(stop);
    root.append(stop);
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const move = (ev) => {
      const r = track.getBoundingClientRect();
      if (!r.width) return;
      select(Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * (n - 1)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, { signal });
  select(Math.max(0, items.findIndex((it) => it.value === value)), false);
}

function buildDials() {
  const showLayout = (it) => {
    $('#layout-name').textContent = it.label.replace(' ✦', '');
    $('#layout-desc').textContent = it.desc;
  };
  makeDial($('#layout-dial'), LAYOUTS, state.user.template, (it) => {
    showLayout(it);
    lookChanged({ template: it.value });
  });
  makeDial($('#color-dial'), PALETTES, state.user.theme, (it) => {
    $('#color-name').textContent = it.label;
    lookChanged({ theme: it.value });
  });
  showLayout(LAYOUTS.find((l) => l.value === state.user.template) || LAYOUTS[0]);
  $('#color-name').textContent = (PALETTES.find((p) => p.value === state.user.theme) || PALETTES[0]).label;
}

// Layout and color changes are applied to the preview instantly (no reload), then saved in the background.
let saveTimer, pendingLook = {}, previewStale = false;
function lookChanged(patch) {
  Object.assign(state.user, patch);
  Object.assign(pendingLook, patch);
  if (!applyLookToPreview()) previewStale = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const send = pendingLook;
    pendingLook = {};
    try {
      await saveProfile(send);
      if (previewStale) reloadPreview();
    } catch (err) {
      // Not saved: put the controls and preview back to what the server has, so nothing looks saved that isn't.
      toast(`Couldn't save the new look: ${err.message}`, 5000);
      try {
        const me = await api('GET', '/api/me');
        state.user.template = me.user.template;
        state.user.theme = me.user.theme;
        buildDials();
        if (!applyLookToPreview()) reloadPreview();
      } catch {
        /* offline: leave it */
      }
    }
  }, 250);
}
function applyLookToPreview() {
  try {
    const w = $('#preview').contentWindow;
    if (w && w.Artfolio) {
      w.Artfolio.setLook(state.user.template, state.user.theme);
      return true;
    }
  } catch {
    /* preview not ready yet */
  }
  return false;
}

// Content changes (photos, titles, collections, order) are saved first, then the preview reloads where it was scrolled to.
function loadPreview() {
  previewStale = false;
  $('#preview').src = `/u/${state.user.username}?_=${Date.now()}`;
}
let reloadTimer;
function reloadPreview() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const f = $('#preview');
    let y = 0;
    try {
      y = f.contentWindow.scrollY || 0;
    } catch {
      /* ignore */
    }
    previewStale = false;
    f.src = `/u/${state.user.username}?_=${Date.now()}`;
    f.addEventListener('load', () => { try { f.contentWindow.scrollTo(0, y); } catch { /* ignore */ } }, { once: true });
  }, 250);
}
const setPreviewSize = (phone) => {
  $('#live-frame').classList.toggle('phone', phone);
  $('#v-phone').setAttribute('aria-pressed', String(phone));
  $('#v-desk').setAttribute('aria-pressed', String(!phone));
};
$('#v-desk').addEventListener('click', () => setPreviewSize(false));
$('#v-phone').addEventListener('click', () => setPreviewSize(true));

// ================= collections =================
function renderCollections() {
  const chips = $('#chips');
  chips.replaceChildren(
    ...state.collections.map((c) =>
      el(
        'span',
        { className: 'chip' },
        el('button', { type: 'button', textContent: c.name, title: 'Rename', onclick: () => renameCollection(c) }),
        el('button', { type: 'button', textContent: '×', title: 'Delete collection', ariaLabel: `Delete collection ${c.name}`, onclick: () => deleteCollection(c) })
      )
    )
  );
}
$('#coll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#coll-name');
  if (!input.value.trim()) return;
  try {
    state.collections.push(await api('POST', '/api/collections', { name: input.value }));
    input.value = '';
    renderCollections();
    renderWorks();
    reloadPreview();
  } catch (err) {
    toast(err.message);
  }
});
async function renameCollection(c) {
  const name = prompt('Rename collection', c.name);
  if (name === null || !name.trim() || name === c.name) return;
  try {
    await api('PATCH', `/api/collections/${c.id}`, { name });
    c.name = name.trim();
    renderCollections();
    renderWorks();
    reloadPreview();
  } catch (err) {
    toast(err.message);
  }
}
async function deleteCollection(c) {
  if (!confirm(`Delete the collection "${c.name}"? Your works are kept, they just won't be in a collection.`)) return;
  try {
    await api('DELETE', `/api/collections/${c.id}`);
    state.collections = state.collections.filter((x) => x.id !== c.id);
    state.works.forEach((w) => w.collectionId === c.id && (w.collectionId = null));
    renderCollections();
    renderWorks();
    reloadPreview();
  } catch (err) {
    toast(err.message);
  }
}

// ================= works =================
let dragId = null;

function renderWorks() {
  const grid = $('#works');
  grid.replaceChildren(...state.works.map(workCard));
  $('#empty').hidden = state.works.length > 0;
}

function workCard(w, i) {
  const card = el('article', { className: 'work' });
  card.dataset.id = w.id;

  const cover = el('div', { className: 'cover' }, el('img', { src: w.images[0]?.thumb || '', alt: w.title || 'Artwork', loading: 'lazy' }));

  // extra images strip
  const strip = el('div', { className: 'strip' });
  if (w.images.length > 1) {
    for (const im of w.images) {
      strip.append(
        el(
          'span',
          { className: 'thumb' },
          el('img', { src: im.thumb, alt: '' }),
          el('button', { type: 'button', textContent: '×', ariaLabel: 'Remove this image', title: 'Remove this image', onclick: () => removeImage(w, im) })
        )
      );
    }
  }
  const picker = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    addFiles([...picker.files], w.id);
    picker.value = '';
  });
  strip.append(
    el('button', { type: 'button', className: 'add-img', textContent: '+', title: 'Add more images to this piece', ariaLabel: 'Add more images to this piece', onclick: () => picker.click() }),
    picker
  );

  const title = el('input', { placeholder: 'Title', maxLength: 120, value: w.title, ariaLabel: 'Title' });
  const desc = el('textarea', { placeholder: 'Description: medium, size, year, the story…', rows: 3, maxLength: 2000, value: w.description, ariaLabel: 'Description' });
  const coll = el(
    'select',
    { ariaLabel: 'Collection' },
    el('option', { value: '', textContent: 'No collection' }),
    ...state.collections.map((c) => el('option', { value: String(c.id), textContent: c.name }))
  );
  coll.value = w.collectionId === null ? '' : String(w.collectionId);

  const save = async () => {
    const patch = { title: title.value, description: desc.value, collectionId: coll.value === '' ? null : Number(coll.value) };
    if (patch.title === w.title && patch.description === w.description && patch.collectionId === w.collectionId) return;
    try {
      await api('PATCH', `/api/works/${w.id}`, patch);
      Object.assign(w, patch);
      cover.firstChild.alt = w.title || 'Artwork';
      toast('Saved');
      reloadPreview();
    } catch (err) {
      toast(err.message);
    }
  };
  [title, desc, coll].forEach((n) => n.addEventListener('change', save));

  const handle = el('span', { className: 'handle', textContent: '⠿', title: 'Drag to reorder', ariaHidden: 'true' });
  handle.addEventListener('mousedown', () => {
    card.draggable = true;
    // if this press doesn't turn into a drag, switch it off again so text in the fields stays selectable
    window.addEventListener('mouseup', () => dragId === null && (card.draggable = false), { once: true });
  });
  const row = el(
    'div',
    { className: 'row' },
    handle,
    el('button', { type: 'button', textContent: '←', ariaLabel: 'Move earlier', disabled: i === 0, onclick: () => move(i, -1) }),
    el('button', { type: 'button', textContent: '→', ariaLabel: 'Move later', disabled: i === state.works.length - 1, onclick: () => move(i, 1) }),
    el('span', { className: 'spacer' }),
    el('button', { type: 'button', className: 'danger', textContent: 'Delete', ariaLabel: 'Delete this piece', onclick: () => removeWork(w) })
  );

  const hideBox = el('input', { type: 'checkbox', checked: !!w.hidden });
  hideBox.addEventListener('change', async () => {
    try {
      await api('PATCH', `/api/works/${w.id}`, { hidden: hideBox.checked });
      w.hidden = hideBox.checked;
      card.classList.toggle('is-hidden', w.hidden);
      toast(w.hidden ? 'Hidden from your site' : 'Showing on your site');
      reloadPreview();
    } catch (err) {
      hideBox.checked = !hideBox.checked;
      toast(err.message);
    }
  });
  card.classList.toggle('is-hidden', !!w.hidden);
  card.append(cover, strip, el('div', { className: 'body' }, title, desc, coll, el('label', { className: 'hide-row' }, hideBox, 'Hide from my site'), row));

  // drag to reorder (HTML5 DnD, started from the handle only so text fields stay selectable)
  card.addEventListener('dragstart', (e) => {
    dragId = w.id;
    e.dataTransfer.setData('text/plain', String(w.id));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    card.draggable = false;
    $$('.work').forEach((c) => c.classList.remove('dragging', 'drop-before'));
  });
  card.addEventListener('dragover', (e) => {
    if (dragId === null || dragId === w.id) return;
    e.preventDefault();
    $$('.work').forEach((c) => c.classList.toggle('drop-before', c === card));
  });
  card.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    reorderTo(dragId, w.id);
  });
  return card;
}

$('#works').addEventListener('dragover', (e) => {
  if (dragId !== null && e.target === e.currentTarget) e.preventDefault();
});
$('#works').addEventListener('drop', (e) => {
  if (dragId !== null && e.target === e.currentTarget) {
    e.preventDefault();
    reorderTo(dragId, null); // dropped in empty space: move to the end
  }
});

// One save at a time, always sending the latest order, so a slow request can't land last with an old order.
let orderBusy = false, orderDirty = false;
async function persistOrder() {
  orderDirty = true;
  if (orderBusy) return;
  orderBusy = true;
  while (orderDirty) {
    orderDirty = false;
    try {
      await api('POST', '/api/works/reorder', { ids: state.works.map((w) => w.id) });
    } catch (err) {
      toast(err.message);
      if (err.status === 409) await load();
      break;
    }
  }
  orderBusy = false;
  reloadPreview();
}
function reorderTo(movingId, beforeId) {
  const from = state.works.findIndex((w) => w.id === movingId);
  const [item] = state.works.splice(from, 1);
  const to = beforeId === null ? state.works.length : state.works.findIndex((w) => w.id === beforeId);
  state.works.splice(to, 0, item);
  renderWorks();
  persistOrder();
}
function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.works.length) return;
  [state.works[i], state.works[j]] = [state.works[j], state.works[i]];
  renderWorks();
  persistOrder();
}

async function removeWork(w) {
  if (!confirm('Delete this piece and all its images? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/works/${w.id}`);
    state.works = state.works.filter((x) => x.id !== w.id);
    renderWorks();
    reloadPreview();
  } catch (err) {
    toast(err.message);
  }
}
async function removeImage(w, im) {
  if (!confirm('Remove this image from the piece?')) return;
  try {
    await api('DELETE', `/api/images/${im.id}`);
    w.images = w.images.filter((x) => x.id !== im.id);
    renderWorks();
    reloadPreview();
  } catch (err) {
    toast(err.message);
  }
}

// ================= publish / draft =================
function renderPublish() {
  const on = !!state.user.published;
  $('#publish').checked = on;
  $('#pub-label').textContent = on ? 'Published' : 'Draft';
  $('#draft-note').hidden = on;
}
async function setPublished(on) {
  try {
    await saveProfile({ published: on });
    renderPublish();
    reloadPreview();
    toast(on ? 'Your site is live' : 'Your site is now a draft');
  } catch (err) {
    renderPublish();
    toast(err.message);
  }
}
$('#publish').addEventListener('change', (e) => setPublished(e.target.checked));
$('#draft-publish').addEventListener('click', () => setPublished(true));

// ================= uploads (with in-browser resize) =================
const FULL_MAX = 2400; // px, longest side of the stored image
const THUMB_MAX = 720;
const SERVER_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Does the picture use transparency? Checked on a small copy, so it's quick even for big photos.
function hasAlpha(bmp) {
  const s = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}
const toBlob = (c, type, quality) => new Promise((resolve) => c.toBlob(resolve, type, quality));
// Scale down to `max` px. Opaque pictures become JPEG; transparent ones keep their transparency
// (WebP where the browser can make it, PNG otherwise) instead of being flattened onto white.
async function scaleToBlob(bmp, max, quality, alpha) {
  const ratio = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * ratio));
  c.height = Math.max(1, Math.round(bmp.height * ratio));
  const ctx = c.getContext('2d');
  if (alpha) {
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const webp = await toBlob(c, 'image/webp', quality);
    if (webp && webp.type === 'image/webp') return webp; // browsers that can't encode WebP hand back a PNG
    const png = await toBlob(c, 'image/png');
    if (png && png.size <= 10 * 1024 * 1024) return png;
  }
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const jpg = await toBlob(c, 'image/jpeg', quality);
  if (!jpg) throw new Error('could not resize this image');
  return jpg;
}

// Returns {full, thumb}. Formats the server doesn't store (HEIC, AVIF, BMP, TIFF...) are always converted.
async function prepare(file) {
  const isGif = file.type === 'image/gif';
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); // for GIFs: the first frame
  } catch {
    if (SERVER_TYPES.includes(file.type)) return { full: file, thumb: null }; // the server will check it
    throw new Error("this browser can't open that kind of image. Try saving it as JPG or PNG first");
  }
  try {
    const side = Math.max(bmp.width, bmp.height);
    const alpha = !isGif && file.type !== 'image/jpeg' && hasAlpha(bmp);
    // GIFs are kept as they are (so they stay animated), but get a still thumbnail when they're heavy
    const convert = !isGif && (!SERVER_TYPES.includes(file.type) || side > FULL_MAX || file.size > 4 * 1024 * 1024);
    const full = convert ? await scaleToBlob(bmp, FULL_MAX, 0.88, alpha) : file;
    const needThumb = isGif ? file.size > 1.5 * 1024 * 1024 : side > THUMB_MAX;
    const thumb = needThumb ? await scaleToBlob(bmp, THUMB_MAX, 0.82, alpha) : null;
    return { full, thumb };
  } finally {
    bmp.close?.();
  }
}

const guessTitle = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120);

async function addFiles(files, workId = null) {
  const list = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));
  if (!list.length) return toast("Those files don't look like images");
  let done = 0;
  for (const file of list) {
    toast(`Uploading ${++done} of ${list.length}…`, 60000);
    try {
      const { full, thumb } = await prepare(file);
      if (full.size > 10 * 1024 * 1024) throw new Error('is over 10 MB');
      const query = workId ? `?work=${workId}` : `?title=${encodeURIComponent(guessTitle(file.name))}`;
      const work = await api('POST', `/api/images${query}`, undefined, full);
      const added = work.images[work.images.length - 1];
      if (thumb) {
        try {
          added.thumb = (await api('PUT', `/api/images/${added.id}/thumb`, undefined, thumb)).thumb;
        } catch {
          /* the full image still works as its own thumbnail */
        }
      }
      const at = state.works.findIndex((w) => w.id === work.id);
      if (at >= 0) state.works[at] = work;
      else state.works.push(work);
      renderWorks();
      reloadPreview();
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 5000);
    }
  }
  toast(list.length === 1 ? 'Added' : `Added ${list.length} images`);
}

const drop = $('#drop');
const fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});

// ================= account =================
const fmtMB = (b) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + ' MB';
const EVENT_LABELS = {
  signup: 'Account created', login: 'Signed in', login_failed: 'Failed sign-in attempt', password_changed: 'Password changed',
  password_reset: 'Password reset by email', reset_requested: 'Password reset code requested', email_verified: 'Email confirmed',
  email_change_requested: 'Email change requested', password_recovered: 'Password reset with recovery key',
  recovery_key_reset: 'New recovery key made', other_sessions_revoked: 'Signed out other devices', published: 'Site published', unpublished: 'Site set to draft',
};
async function loadAccountInfo() {
  try {
    const [me, act] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/activity')]);
    state.storage = me.storage;
    Object.assign(state.user, { email: me.user.email, pendingEmail: me.user.pendingEmail });
    renderEmail();
    $('#meter-fill').style.width = Math.min(100, (me.storage.used / me.storage.limit) * 100) + '%';
    $('#storage-text').textContent = `${fmtMB(me.storage.used)} of ${fmtMB(me.storage.limit)} used`;
    $('#activity').replaceChildren(
      ...act.events.map((ev) => {
        let label = EVENT_LABELS[ev.event] || ev.event;
        if (ev.event === 'login_failed' && Number(ev.detail) > 1) label += ` (×${ev.detail})`;
        return el('li', {}, el('b', { textContent: label }), el('span', { textContent: `${new Date(ev.ts).toLocaleString()} · ${ev.ip}` }));
      })
    );
  } catch (err) {
    toast(err.message);
  }
}

// ----- account email (used for password resets; never shown publicly) -----
function renderEmail() {
  const u = state.user;
  const status = $('#email-status');
  if (u.email && u.pendingEmail) status.textContent = `Your email is ${u.email}. We sent a code to ${u.pendingEmail}; enter it to switch to that address.`;
  else if (u.email) status.textContent = `Password resets go to ${u.email}. It is never shown on your site.`;
  else if (u.pendingEmail) status.textContent = `We sent a code to ${u.pendingEmail}. Enter it below to confirm your email.`;
  else status.textContent = "You haven't added an email yet. Without one, you can't reset a forgotten password.";
  $('#verify-form').hidden = !u.pendingEmail;
  $('#email-form-label').textContent = u.email || u.pendingEmail ? 'Change email' : 'Email';
  const note = $('#email-note');
  note.hidden = !!u.email;
  if (!u.email) {
    const go = el('button', { type: 'button', className: 'link', textContent: u.pendingEmail ? 'Enter the code' : 'Add your email', onclick: () => switchTab('account') });
    note.replaceChildren(
      u.pendingEmail ? `Confirm your email (${u.pendingEmail}) so you can reset your password if you forget it. ` : 'Add an email so you can reset your password if you forget it. ',
      go
    );
  }
}
async function verifyEmail(code) {
  $('#verify-error').textContent = '';
  try {
    const r = await api('POST', '/api/email/verify', { code });
    state.user.email = r.email;
    state.user.pendingEmail = '';
    renderEmail();
    $('#verify-form').reset();
    toast('Email confirmed');
    return true;
  } catch (err) {
    $('#verify-error').textContent = err.message;
    if (err.status === 409) state.user.pendingEmail = '';
    renderEmail();
    switchTab('account');
    toast(err.message, 5000);
    return false;
  }
}
$('#verify-form').addEventListener('submit', (e) => {
  e.preventDefault();
  verifyEmail(e.target.code.value);
});
$('#verify-resend').addEventListener('click', async () => {
  try {
    await api('POST', '/api/email/resend');
    toast(`New code sent to ${state.user.pendingEmail}`);
  } catch (err) {
    $('#verify-error').textContent = err.message;
  }
});
$('#verify-cancel').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/email/pending');
    state.user.pendingEmail = '';
    renderEmail();
  } catch (err) {
    toast(err.message);
  }
});
$('#email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#email-error').textContent = '';
  try {
    const r = await api('POST', '/api/email', { email: f.email.value.trim(), password: f.password.value });
    f.reset();
    state.user.pendingEmail = r.pendingEmail;
    renderEmail();
    toast(`Code sent to ${r.pendingEmail}`);
    $('#verify-form').code.focus();
  } catch (err) {
    $('#email-error').textContent = err.message;
  }
});

$('#revoke-others').addEventListener('click', async () => {
  if (!confirm('Sign out every other device where you are logged in?')) return;
  try {
    const r = await api('POST', '/api/sessions/revoke-others');
    toast(r.revoked ? `Signed out ${r.revoked} other ${r.revoked === 1 ? 'session' : 'sessions'}` : 'No other devices were signed in');
    loadAccountInfo();
  } catch (err) {
    toast(err.message);
  }
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#pw-error').textContent = '';
  try {
    await api('POST', '/api/password', { current: f.current.value, next: f.next.value });
    f.reset();
    toast('Password changed');
  } catch (err) {
    $('#pw-error').textContent = err.message;
  }
});
$('#del-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#del-error').textContent = '';
  if (!confirm('Really delete your whole portfolio and account? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/account', { password: f.password.value });
    f.reset();
    state = { user: null, collections: [], works: [] };
    show();
    toast('Your account was deleted');
  } catch (err) {
    $('#del-error').textContent = err.message;
  }
});

start();
