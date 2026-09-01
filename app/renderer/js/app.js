'use strict';

/* Astra Client renderer. Talks to the main process only through window.astra. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  settings: null,
  versions: [],
  latest: {},
  profiles: [],
  selected: null,
  loaders: {},
  launching: false,
  mods: {
    type: 'mod',
    loaded: false,
    query: '',
    category: '',
    sort: 'relevance',
    offset: 0,
    total: 0,
    hits: [],
    installed: [],
    busy: false
  }
};

// ---------------------------------------------------------------- helpers

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  }, kind === 'error' ? 7000 : 3600);
}

function loaderLabel(loader) {
  return { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[loader] || loader;
}

function badgeFor(loader) {
  return { vanilla: 'MC', fabric: 'FAB', quilt: 'QLT', forge: 'FRG', neoforge: 'NEO' }[loader] || 'MC';
}

// ---------------------------------------------------------------- splash

async function runSplash(steps) {
  const fill = $('#splash-bar-fill');
  const status = $('#splash-status');
  let done = 0;

  for (const [label, work] of steps) {
    status.textContent = label;
    try {
      await work();
    } catch (err) {
      // A failed step must not trap the user on the splash screen forever.
      console.error(label, err);
      toast(`${label} failed: ${err.message}`, 'error');
    }
    done++;
    fill.style.width = `${Math.round((done / steps.length) * 100)}%`;
  }

  status.textContent = 'Ready';
  await new Promise((r) => setTimeout(r, 520));
  $('#splash').classList.add('gone');
}

// ---------------------------------------------------------------- navigation

const VIEW_ORDER = ['home', 'versions', 'mods', 'shaders', 'wardrobe', 'shop',
  'friends', 'servers', 'notes', 'settings'];

/**
 * Staggered entry for a list of freshly built elements.
 *
 * The guard matters: a CSS animation attached to an element inside a `display:none`
 * tab never starts, and the element then sits at opacity 0 forever once the tab is
 * shown. So the class only goes on when the element is genuinely laid out, and
 * showView re-runs this whenever a view is revealed.
 */
function popIn(container, step = 40) {
  if (!container) return;
  const items = Array.from(container.querySelectorAll('.pop-item'));
  if (!items.length) return;

  if (!container.offsetParent) {
    // Hidden right now: leave them primed and let showView deal with it on reveal.
    items.forEach((el) => el.classList.remove('pop'));
    return;
  }
  items.forEach((el) => el.classList.remove('pop'));
  requestAnimationFrame(() => {
    items.forEach((el, i) => {
      el.style.animationDelay = `${Math.min(i * step, 400)}ms`;
      el.classList.add('pop');
    });
  });
}

/** The sliding marker on the left rail. */
const railIndicator = document.createElement('div');
railIndicator.className = 'rail-indicator';
$('.rail').appendChild(railIndicator);

function moveIndicator(button) {
  if (!button) return;
  const rail = $('.rail');
  const top = button.offsetTop + (button.offsetHeight - 22) / 2;
  railIndicator.style.transform = `translateY(${top}px)`;
  railIndicator.classList.add('ready');
  void rail.offsetHeight;
}

let currentView = 'home';

function showView(name) {
  if (name === currentView) return;

  const fromIndex = VIEW_ORDER.indexOf(currentView);
  const toIndex = VIEW_ORDER.indexOf(name);
  const direction = toIndex > fromIndex ? 'enter-right' : 'enter-left';

  $$('.view').forEach((view) => {
    const active = view.dataset.view === name;
    view.classList.remove('enter-right', 'enter-left');
    view.classList.toggle('active', active);
    if (active) {
      // Restart the animation cleanly rather than relying on class order.
      void view.offsetWidth;
      view.classList.add(direction);
      popIn(view);
    }
  });

  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  moveIndicator($$('.rail-btn').find((b) => b.dataset.view === name));

  currentView = name;
  onViewShown(name);
}

/** Work that only makes sense once a tab is actually visible. */
function onViewShown(name) {
  if (name === 'versions' && !$('#version-list').childElementCount) {
    renderVersionList();
  }
  if (name === 'mods') {
    refreshModsTarget();
    if (!state.mods.loaded) runModSearch(true);
    renderInstalled();
  }
  if (name === 'wardrobe') refreshWardrobe();
  if (name === 'shop') refreshShop();
  if (name === 'friends') refreshFriends();
  if (name === 'servers') refreshServers();
  if (name === 'notes') renderNotes();
}

$$('.rail-btn').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

/* Ripple on every pressable control, including ones added later. */
document.addEventListener('pointerdown', (event) => {
  const target = event.target.closest(
    '.play-btn, .primary-btn, .ghost-btn, .pill, .mini-btn, .tab, .icon-btn, .install-btn');
  if (!target || target.disabled) return;

  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
  ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
  target.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
});

$('#win-min').addEventListener('click', () => window.astra.window.minimize());
$('#win-max').addEventListener('click', () => window.astra.window.maximize());
$('#win-close').addEventListener('click', () => window.astra.window.close());

// ---------------------------------------------------------------- music

const theme = $('#theme');
let musicReady = false;

function applyMusic() {
  const { musicEnabled, musicVolume } = state.settings;
  theme.volume = Number(musicVolume) || 0.35;
  $('#btn-music').classList.toggle('on', Boolean(musicEnabled));

  // Seasonal track replaces the usual one while a season is on.
  const season = typeof currentSeason === 'function' ? currentSeason() : null;
  const seasonal = season && state.settings.seasonMedia !== false ? SEASONS[season] : null;
  const wanted = seasonal ? seasonal.music : '../assets/theme.mp3';

  if (!theme.src.endsWith(wanted.replace('../', ''))) {
    const wasPlaying = !theme.paused;
    theme.src = wanted;
    theme.load();
    if (wasPlaying && musicEnabled) theme.play().catch(() => {});
  }

  if (musicEnabled) {
    // Chromium blocks autoplay until the user has interacted with the page, so the
    // first real click is what actually starts it.
    theme.play().then(() => { musicReady = true; }).catch(() => { musicReady = false; });
  } else {
    theme.pause();
  }
}

document.addEventListener('click', () => {
  if (state.settings && state.settings.musicEnabled && !musicReady) applyMusic();
}, { once: false });

$('#btn-music').addEventListener('click', async () => {
  state.settings.musicEnabled = !state.settings.musicEnabled;
  await window.astra.settings.set({ musicEnabled: state.settings.musicEnabled });
  $('#set-music').checked = state.settings.musicEnabled;
  applyMusic();
});

const BACKGROUNDS = [
  { id: 'aurora.mp4', label: 'Aurora (video)', video: true },
  { id: 'bg1.jpg', label: 'Panorama' },
  { id: 'bg2.jpg', label: 'Deep wood' },
  { id: 'bg3.jpg', label: 'Sunset' },
  { id: 'bg4.jpg', label: 'Cliffs' }
];

function applyBackground() {
  const video = $('#bg-video');
  const still = $('#bg-still');
  const enabled = state.settings.backgroundEnabled !== false;

  // A season takes over the backdrop unless seasonal media is switched off.
  const season = typeof currentSeason === 'function' ? currentSeason() : null;
  const seasonal = season && state.settings.seasonMedia !== false ? SEASONS[season] : null;
  const choice = seasonal ? seasonal.background : (state.settings.background || 'aurora.mp4');

  const tint = seasonal ? seasonal.filter : '';
  video.style.filter = tint;
  still.style.filter = tint;

  if (!enabled) {
    video.classList.add('off');
    video.pause();
    still.style.opacity = '0';
    return;
  }

  if (choice.endsWith('.mp4')) {
    // Seasonal clips live beside the default one, so the source may need swapping.
    const wanted = `../assets/${choice === 'aurora.mp4' ? 'background.mp4' : choice}`;
    if (!video.src.endsWith(wanted.replace('../', ''))) {
      video.src = wanted;
      video.load();
    }
    video.classList.remove('off');
    video.play().catch(() => {});
    still.style.opacity = '0';
  } else {
    // A still costs nothing to render, so the video is stopped rather than hidden.
    video.classList.add('off');
    video.pause();
    still.style.backgroundImage = `url("../assets/backgrounds/${choice}")`;
    still.style.opacity = '1';
  }
}

function renderBackgroundPicker() {
  const picker = $('#bg-picker');
  if (!picker) return;
  picker.innerHTML = '';

  for (const background of BACKGROUNDS) {
    const option = document.createElement('div');
    option.className = 'bg-option' + (state.settings.background === background.id ? ' selected' : '');
    option.style.backgroundImage = background.video
      ? 'linear-gradient(135deg, #1B2740, #0E1119)'
      : `url("../assets/backgrounds/${background.id}")`;

    const label = document.createElement('span');
    label.textContent = background.label;
    option.appendChild(label);

    option.addEventListener('click', async () => {
      state.settings.background = background.id;
      await window.astra.settings.set({ background: background.id });
      renderBackgroundPicker();
      applyBackground();
    });
    picker.appendChild(option);
  }
  const season = currentSeason();
  $('#bg-name').textContent = season && state.settings.seasonMedia !== false
    ? `${SEASONS[season].label} season is using its own backdrop`
    : (BACKGROUNDS.find((b) => b.id === state.settings.background) || BACKGROUNDS[0]).label;
}

/**
 * Seasons.
 *
 * Each one repaints the accent colours, swaps the backdrop and changes the music. The
 * mode can be forced rather than only following the calendar - without that the whole
 * feature is invisible for ten months of the year and looks broken when you toggle it.
 */
const SEASONS = {
  halloween: {
    label: 'Halloween',
    background: 'bg2.jpg',
    filter: 'sepia(.45) hue-rotate(-18deg) saturate(1.5) brightness(.72)',
    music: '../assets/seasonal/halloween.mp3',
    profileName: 'Halloween Event'
  },
  christmas: {
    label: 'Festive',
    background: 'seasonal/christmas.mp4',
    filter: 'saturate(1.1)',
    music: '../assets/seasonal/christmas.mp3',
    profileName: 'Festive Event'
  }
};

/** What the calendar says, ignoring any override. */
function calendarSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month === 10) return 'halloween';
  if (month === 12 || (month === 1 && day <= 5)) return 'christmas';
  return null;
}

/** The season actually in effect, honouring the setting. */
function currentSeason() {
  const mode = state.settings.seasonMode || 'auto';
  if (mode === 'off') return null;
  if (mode === 'auto') return calendarSeason();
  return SEASONS[mode] ? mode : null;
}

function applySeason() {
  const season = currentSeason();
  document.body.classList.remove('season-halloween', 'season-christmas');
  if (season) document.body.classList.add(`season-${season}`);

  const hint = $('#seasonal-hint');
  if (hint) {
    const calendar = calendarSeason();
    const mode = state.settings.seasonMode || 'auto';
    hint.textContent = season
      ? `${SEASONS[season].label} is on${mode !== 'auto' ? ' (forced)' : ' now'}`
      : calendar ? 'Turned off' : 'Nothing in season - Halloween in October, festive in December';
  }

  const profileHint = $('#seasonal-profile-hint');
  if (profileHint) {
    profileHint.textContent = season
      ? `Creates a "${SEASONS[season].profileName}" profile on the newest release`
      : 'Pick a season first';
  }

  applyBackground();
  applyMusic();
  return season;
}

// ---------------------------------------------------------------- account

function renderAccount() {
  const account = state.settings.account;
  const nameEl = $('#account-name');
  const headEl = $('#account-head');

  if (account) {
    nameEl.textContent = account.name;
    headEl.src = `https://mc-heads.net/avatar/${account.id}/48`;
    headEl.style.visibility = 'visible';
    $('#set-account-name').textContent = account.name;
    $('#btn-signin').hidden = true;
    $('#btn-signout').hidden = false;
  } else {
    nameEl.textContent = 'Not signed in';
    headEl.removeAttribute('src');
    headEl.style.visibility = 'hidden';
    $('#set-account-name').textContent = 'Not signed in';
    $('#btn-signin').hidden = false;
    $('#btn-signout').hidden = true;
  }
  updatePlayState();

  // The model is built from the account's skin, so it has to be rebuilt when the
  // account appears or changes - otherwise it keeps whatever it drew before sign-in.
  if (typeof wardrobe !== 'undefined' && $('#cape-stage')) {
    renderCapePreview(findCosmetic(wardrobe.selected));
  }
}

$('#account-chip').addEventListener('click', () => {
  if (!state.settings.account) signIn();
  else showView('settings');
});

async function signIn() {
  try {
    toast('Opening the Microsoft sign in window');
    const account = await window.astra.auth.signIn();
    state.settings.account = account;
    renderAccount();
    toast(`Signed in as ${account.name}`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#btn-signin').addEventListener('click', signIn);
$('#btn-signout').addEventListener('click', async () => {
  await window.astra.auth.signOut();
  state.settings.account = null;
  renderAccount();
  toast('Signed out');
});

// ---------------------------------------------------------------- versions

function releaseVersions() {
  return state.versions.filter((v) => v.type === 'release');
}

function visibleVersions() {
  return state.settings.showSnapshots ? state.versions : releaseVersions();
}

function renderPills() {
  const pills = $('#version-pills');
  pills.innerHTML = '';
  // A handful of recent releases as one-click shortcuts, like the reference layout.
  releaseVersions().slice(0, 6).forEach((v) => {
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.textContent = v.id;
    btn.addEventListener('click', () => {
      showView('versions');
      $('#pick-version').value = v.id;
      onVersionChange();
    });
    pills.appendChild(btn);
  });

  const more = document.createElement('button');
  more.className = 'pill';
  more.textContent = 'Browse Versions';
  more.addEventListener('click', () => showView('versions'));
  pills.appendChild(more);
}

function renderVersionSelect() {
  const select = $('#pick-version');
  const current = select.value;
  select.innerHTML = '';
  for (const v of visibleVersions()) {
    const option = document.createElement('option');
    option.value = v.id;
    option.textContent = v.type === 'release' ? v.id : `${v.id}  (${v.type})`;
    select.appendChild(option);
  }
  select.value = current && visibleVersions().some((v) => v.id === current)
    ? current
    : (state.latest.release || (visibleVersions()[0] || {}).id || '');
  updateVersionDetail(select.value);
}

async function onVersionChange() {
  const mcVersion = $('#pick-version').value;
  const loaderSelect = $('#pick-loader');
  const note = $('#loader-note');

  loaderSelect.innerHTML = '<option value="vanilla">Vanilla</option>';
  $('#pick-loader-version').innerHTML = '';
  note.textContent = 'Checking which mod loaders support this version...';

  try {
    const loaders = await window.astra.versions.loaders(mcVersion);
    state.loaders = loaders;

    const available = ['fabric', 'quilt', 'neoforge', 'forge']
      .filter((name) => (loaders[name] || []).length);

    for (const name of available) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = loaderLabel(name);
      loaderSelect.appendChild(option);
    }

    note.textContent = available.length
      ? `Mod loaders for ${mcVersion}: ${available.map(loaderLabel).join(', ')}.`
      : `No mod loader has a build for ${mcVersion} yet - vanilla only.`;
  } catch (err) {
    note.textContent = `Could not reach the loader services: ${err.message}`;
  }
  onLoaderChange();
}

function onLoaderChange() {
  const loader = $('#pick-loader').value;
  const select = $('#pick-loader-version');
  select.innerHTML = '';

  if (loader === 'vanilla') {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Not applicable';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  const builds = state.loaders[loader] || [];
  builds.forEach((build, index) => {
    const option = document.createElement('option');
    option.value = build.id;
    option.textContent = index === 0 ? `${build.id}  (latest)` : build.id;
    select.appendChild(option);
  });
}

$('#pick-version').addEventListener('change', onVersionChange);
$('#pick-loader').addEventListener('change', onLoaderChange);

$('#show-snapshots').addEventListener('change', async (e) => {
  state.settings.showSnapshots = e.target.checked;
  await window.astra.settings.set({ showSnapshots: e.target.checked });
  renderVersionSelect();
  onVersionChange();
  renderVersionList();
});

$('#btn-create').addEventListener('click', async () => {
  const profile = {
    mcVersion: $('#pick-version').value,
    loader: $('#pick-loader').value,
    loaderVersion: $('#pick-loader-version').value || '',
    name: $('#pick-name').value.trim()
  };
  if (!profile.mcVersion) return toast('Pick a Minecraft version first', 'error');
  if (profile.loader !== 'vanilla' && !profile.loaderVersion) {
    return toast('That loader has no build for this version', 'error');
  }

  const saved = await window.astra.profiles.save(profile);
  $('#pick-name').value = '';
  await refreshProfiles(saved.id);
  toast(`Created ${saved.name}`, 'ok');
  showView('home');
});

// ---------------------------------------------------------------- profiles

async function refreshProfiles(selectId) {
  state.profiles = await window.astra.profiles.list();
  state.selected = selectId
    || (state.profiles.some((p) => p.id === state.settings.lastProfile) ? state.settings.lastProfile : null)
    || (state.profiles[0] && state.profiles[0].id)
    || null;
  renderProfiles();
  renderHomeProfiles();
  updatePlayState();
}

function renderProfiles() {
  const grid = $('#profile-grid');
  grid.innerHTML = '';

  if (!state.profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'panel empty-panel';
    empty.innerHTML = '<p>No profiles yet. Pick a version above and press Create.</p>';
    grid.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    const card = document.createElement('div');
    card.className = 'profile-card pop-item' + (profile.id === state.selected ? ' selected' : '');

    const badge = document.createElement('div');
    badge.className = 'profile-badge';
    badge.textContent = badgeFor(profile.loader);

    const info = document.createElement('div');
    info.className = 'profile-info';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = profile.name;
    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    meta.textContent = profile.loader === 'vanilla'
      ? `Minecraft ${profile.mcVersion}`
      : `${loaderLabel(profile.loader)} ${profile.loaderVersion} - ${profile.mcVersion}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'profile-actions';

    const folder = document.createElement('button');
    folder.className = 'mini-btn';
    folder.title = 'Open folder';
    folder.textContent = '\u{1F4C1}';
    folder.addEventListener('click', (e) => {
      e.stopPropagation();
      window.astra.profiles.openFolder(profile.id);
    });

    const remove = document.createElement('button');
    remove.className = 'mini-btn danger';
    remove.title = 'Delete profile';
    remove.textContent = '✕';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.astra.profiles.remove(profile.id);
      await refreshProfiles();
      toast('Profile deleted');
    });

    actions.append(folder, remove);
    card.append(badge, info, actions);
    card.addEventListener('click', () => {
      state.selected = profile.id;
      renderProfiles();
      renderHomeProfiles();
      updatePlayState();
      onProfileChanged();
    });
    grid.appendChild(card);
  }
  popIn(grid);
}

function renderHomeProfiles() {
  const select = $('#home-profile');
  select.innerHTML = '';
  for (const profile of state.profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  }
  if (state.selected) select.value = state.selected;

  const profile = state.profiles.find((p) => p.id === state.selected);
  $('#hero-title').textContent = profile ? profile.name : 'No profile yet';
  $('#hero-sub').textContent = profile
    ? (profile.loader === 'vanilla'
      ? `Vanilla Minecraft ${profile.mcVersion}`
      : `${loaderLabel(profile.loader)} ${profile.loaderVersion} on ${profile.mcVersion}`)
    : 'Go to Versions and create one.';
  updateHeroArt();
}

$('#home-profile').addEventListener('change', (e) => {
  state.selected = e.target.value;
  renderProfiles();
  renderHomeProfiles();
  onProfileChanged();
});

/** A different loader or version means the whole mod list no longer applies. */
function onProfileChanged() {
  state.mods.loaded = false;
  state.mods.offset = 0;
  refreshModsTarget();
  renderInstalled();
  if (currentView === 'mods') runModSearch(true);
}

$('#btn-open-mods').addEventListener('click', () => {
  if (!state.selected) return toast('Create a profile first', 'error');
  if (isShaders()) window.astra.shaders.folder(state.selected);
  else window.astra.profiles.openFolder(state.selected);
});

// ---------------------------------------------------------------- launching

function updatePlayState() {
  const ready = Boolean(state.settings.account) && Boolean(state.selected) && !state.launching;
  const btn = $('#btn-play');
  btn.disabled = !ready;
  btn.querySelector('span').textContent = state.launching ? 'WORKING' : 'PLAY';

  if (!state.settings.account) btn.title = 'Sign in with Microsoft first';
  else if (!state.selected) btn.title = 'Create a profile first';
  else btn.title = '';
}

$('#btn-play').addEventListener('click', async () => {
  if (state.launching || !state.selected) return;
  state.launching = true;
  updatePlayState();

  $('#progress-card').hidden = false;
  $('#console').textContent = '';
  $('#console-panel').hidden = true;
  $('#doctor-panel').hidden = true;
  crashLog.length = 0;

  try {
    // Catch a mod that cannot possibly load here before spending a launch on it.
    // Never fatal: a check that fails must not stop someone playing.
    try {
      const problems = await window.astra.doctor.check(state.selected);
      if (problems.length) showDoctor(problems, 'Before you play');
    } catch (_) { /* the game still gets its chance */ }

    await window.astra.launch.start(state.selected);
  } catch (err) {
    toast(err.message, 'error');
    state.launching = false;
    $('#progress-card').hidden = true;
    updatePlayState();
  }
});

$('#btn-stop').addEventListener('click', async () => {
  await window.astra.launch.stop();
  toast('Stopped Minecraft');
});

// ---------------------------------------------------------------- doctor

/*
 * When the game exits badly, read the log it just printed, say which mod did it,
 * and offer the repair.
 *
 * Fixes are always a button, never automatic. Disabling the wrong mod silently
 * would be worse than the crash, and the log is not always conclusive - so Astra
 * says what it thinks and lets the player decide.
 */

const crashLog = [];

function showDoctor(findings, title) {
  const panel = $('#doctor-panel');
  const list = $('#doctor-list');
  $('#doctor-title').textContent = title || 'What went wrong';
  list.innerHTML = '';

  for (const finding of findings) {
    const item = document.createElement('div');
    item.className = `doctor-item ${finding.severity || 'warn'}`;

    const text = document.createElement('div');
    text.className = 'doctor-text';

    const heading = document.createElement('h4');
    heading.textContent = finding.title;
    const detail = document.createElement('p');
    detail.textContent = finding.detail;
    text.append(heading, detail);

    if (finding.mod) {
      const tag = document.createElement('span');
      tag.className = 'doctor-mod';
      tag.textContent = finding.mod.version
        ? `${finding.mod.name}  ${finding.mod.version}`
        : finding.mod.name;
      text.appendChild(tag);
    }

    item.appendChild(text);

    if (finding.fix) {
      const button = document.createElement('button');
      button.className = 'primary-btn small';
      button.textContent = {
        disable: 'Turn it off', install: 'Get it', replace: 'Get the right one',
        memory: 'Fix memory'
      }[finding.fix.type] || 'Fix it';

      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Working...';
        try {
          const result = await window.astra.doctor.fix(state.selected, finding.fix);
          toast(result.message, 'ok');
          button.textContent = 'Done';
          // A memory fix changes settings the panel is showing.
          if (result.settings) {
            state.settings = await window.astra.settings.get();
            $('#set-memory').value = state.settings.memoryMb;
            $('#set-memory-value').textContent =
              `${(state.settings.memoryMb / 1024).toFixed(1)} GB`;
          }
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
          button.textContent = 'Try again';
        }
      });

      item.appendChild(button);
    }

    list.appendChild(item);
  }

  panel.hidden = false;
  popIn(list);
}

async function runDoctor() {
  if (!state.selected || !crashLog.length) return;
  try {
    const findings = await window.astra.doctor.diagnose(state.selected, crashLog);
    if (findings.length) {
      showDoctor(findings);
    } else {
      showDoctor([{
        severity: 'warn',
        title: 'Astra could not work out what went wrong',
        detail: 'Nothing in the log matched a known cause. The full output is below - '
          + 'the last error line in it is usually the culprit.',
        mod: null,
        fix: null
      }]);
    }
  } catch (err) {
    toast(`Could not read the crash: ${err.message}`, 'error');
  }
}

$('#btn-doctor-close').addEventListener('click', () => {
  $('#doctor-panel').hidden = true;
});

window.astra.launch.onEvent((event) => {
  if (event.type === 'progress') {
    const { stage, message, done, total } = event;
    $('#progress-stage').textContent = {
      version: 'Reading version', client: 'Downloading the game', loader: 'Installing the loader',
      libraries: 'Libraries', natives: 'Natives', assets: 'Assets', done: 'Ready'
    }[stage] || stage;
    $('#progress-count').textContent = total ? `${done} / ${total}` : '';
    $('#progress-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
    $('#progress-detail').textContent = message || '';
  } else if (event.type === 'status') {
    $('#progress-stage').textContent = event.message;
    $('#progress-detail').textContent = '';
  } else if (event.type === 'started') {
    state.launching = false;
    updatePlayState();
    $('#progress-card').hidden = true;
    $('#console-panel').hidden = false;
    toast(`Minecraft ${event.versionId} is starting`, 'ok');
  } else if (event.type === 'log') {
    // The console element is trimmed to its tail for display, so the log used for
    // a diagnosis is kept separately - a crash cause is usually printed well before
    // the 500 lines of shutdown noise that follow it.
    crashLog.push(event.line);
    while (crashLog.length > 3000) crashLog.shift();

    const console_ = $('#console');
    const line = document.createElement('div');
    if (event.channel === 'err') line.className = 'err';
    line.textContent = event.line;
    console_.appendChild(line);
    // Keep the tail only; a long session would otherwise grow without limit.
    while (console_.childNodes.length > 500) console_.removeChild(console_.firstChild);
    console_.scrollTop = console_.scrollHeight;
  } else if (event.type === 'exit') {
    state.launching = false;
    updatePlayState();
    toast(event.code === 0 ? 'Minecraft closed' : `Minecraft exited with code ${event.code}`,
      event.code === 0 ? '' : 'error');
    if (event.code !== 0) runDoctor();
  } else if (event.type === 'error') {
    state.launching = false;
    updatePlayState();
    $('#progress-card').hidden = true;
    toast(event.message, 'error');
  }
});

// ---------------------------------------------------------------- settings ui

function bindSettings() {
  const s = state.settings;

  $('#set-memory').value = s.memoryMb;
  $('#set-memory-value').textContent = `${(s.memoryMb / 1024).toFixed(1)} GB`;
  $('#set-memory').addEventListener('input', (e) => {
    $('#set-memory-value').textContent = `${(e.target.value / 1024).toFixed(1)} GB`;
  });
  $('#set-memory').addEventListener('change', (e) => {
    s.memoryMb = Number(e.target.value);
    window.astra.settings.set({ memoryMb: s.memoryMb });
  });

  $('#set-width').value = s.width;
  $('#set-height').value = s.height;
  $('#set-width').addEventListener('change', (e) => window.astra.settings.set({ width: Number(e.target.value) }));
  $('#set-height').addEventListener('change', (e) => window.astra.settings.set({ height: Number(e.target.value) }));

  $('#set-dir-value').textContent = s.gameDir;
  $('#btn-pick-dir').addEventListener('click', async () => {
    const dir = await window.astra.settings.pickFolder();
    if (!dir) return;
    s.gameDir = dir;
    await window.astra.settings.set({ gameDir: dir });
    $('#set-dir-value').textContent = dir;
    toast('Game folder updated');
  });

  $('#set-java-value').textContent = s.javaPath || 'Detected automatically';
  $('#btn-pick-java').addEventListener('click', async () => {
    const file = await window.astra.settings.pickJava();
    if (!file) return;
    s.javaPath = file;
    await window.astra.settings.set({ javaPath: file });
    $('#set-java-value').textContent = file;
  });
  $('#btn-scan-java').addEventListener('click', async () => {
    toast('Looking for Java installations...');
    const found = await window.astra.java.scan();
    toast(found.length
      ? `Found Java ${found.map((j) => j.major).join(', ')}`
      : 'No Java found - install Java 17 or newer', found.length ? 'ok' : 'error');
  });

  $('#set-jvm').value = s.jvmArgs;
  $('#set-jvm').addEventListener('change', (e) => window.astra.settings.set({ jvmArgs: e.target.value }));

  $('#set-bg').checked = s.backgroundEnabled;
  $('#set-bg').addEventListener('change', (e) => {
    s.backgroundEnabled = e.target.checked;
    window.astra.settings.set({ backgroundEnabled: e.target.checked });
    applyBackground();
  });

  $('#set-music').checked = s.musicEnabled;
  $('#set-music').addEventListener('change', (e) => {
    s.musicEnabled = e.target.checked;
    window.astra.settings.set({ musicEnabled: e.target.checked });
    applyMusic();
  });

  $('#set-volume').value = s.musicVolume;
  $('#set-volume').addEventListener('input', (e) => {
    s.musicVolume = Number(e.target.value);
    theme.volume = s.musicVolume;
  });
  $('#set-volume').addEventListener('change', () => window.astra.settings.set({ musicVolume: s.musicVolume }));

  $('#set-close').checked = s.closeOnLaunch;
  $('#set-close').addEventListener('change', (e) => window.astra.settings.set({ closeOnLaunch: e.target.checked }));

  $('#show-snapshots').checked = s.showSnapshots;

  // ---- appearance ----
  $('#set-season').value = s.seasonMode || 'auto';
  $('#set-season').addEventListener('change', async (e) => {
    s.seasonMode = e.target.value;
    await window.astra.settings.set({ seasonMode: e.target.value });
    applySeason();
    renderBackgroundPicker();
    const season = currentSeason();
    toast(season ? `${SEASONS[season].label} theme on` : 'Seasonal theme off', 'ok');
  });

  $('#set-season-media').checked = s.seasonMedia !== false;
  $('#set-season-media').addEventListener('change', async (e) => {
    s.seasonMedia = e.target.checked;
    await window.astra.settings.set({ seasonMedia: e.target.checked });
    applySeason();
  });

  $('#btn-seasonal-profile').addEventListener('click', createSeasonalProfile);

  // ---- performance ----
  $('#set-perf').value = s.perfPreset || 'balanced';
  $('#set-perf').addEventListener('change', async (e) => {
    s.perfPreset = e.target.value;
    const presets = await window.astra.perf.presets();
    const preset = presets.find((p) => p.id === e.target.value);
    // The preset owns the JVM flags, so reflect them in the box people can see.
    if (preset) {
      s.jvmArgs = preset.jvm;
      $('#set-jvm').value = preset.jvm;
    }
    await window.astra.settings.set({ perfPreset: s.perfPreset, jvmArgs: s.jvmArgs });
    toast(`${preset ? preset.label : e.target.value} preset applied`, 'ok');
  });

  $('#set-priority').value = s.processPriority || 'normal';
  $('#set-priority').addEventListener('change', (e) =>
    window.astra.settings.set({ processPriority: e.target.value }));

  $('#set-write-options').checked = Boolean(s.writeGameOptions);
  $('#set-write-options').addEventListener('change', (e) =>
    window.astra.settings.set({ writeGameOptions: e.target.checked }));

  $('#set-discord').checked = s.discordEnabled !== false;
  $('#set-discord').addEventListener('change', async (e) => {
    const connected = await window.astra.discord.set(e.target.checked);
    $('#discord-state').textContent = e.target.checked
      ? (connected ? 'Connected to Discord' : 'Discord is not running')
      : 'Off';
  });

  // ---- astra account ----
  $('#set-server-url').value = s.serverUrl || '';
  $('#btn-save-server').addEventListener('click', async () => {
    const url = $('#set-server-url').value.trim();
    s.serverUrl = url;
    await window.astra.settings.set({ serverUrl: url });
    toast('Server address saved', 'ok');
    connectAstra();
  });
  $('#btn-connect-astra').addEventListener('click', connectAstra);
}

/** Signs in to the Astra backend using the Minecraft session we already hold. */
async function connectAstra(quiet) {
  const stateEl = $('#astra-state');
  const hint = $('#astra-hint');
  if (!state.settings.account) {
    if (!quiet) toast('Sign in to Minecraft first', 'error');
    return false;
  }
  try {
    const player = await window.astra.api.connect();
    stateEl.textContent = `Connected as ${player.name}`;
    hint.textContent = `${player.coins} coins`;
    if (!quiet) toast('Connected to Astra', 'ok');
    return true;
  } catch (err) {
    stateEl.textContent = 'Not connected';
    hint.textContent = err.message;
    if (!quiet) toast(err.message, 'error');
    return false;
  }
}

/**
 * Builds the featured profile for whatever season it is, on the newest release -
 * that is where Mojang runs the seasonal event.
 */
async function createSeasonalProfile() {
  const season = currentSeason();
  if (!season) return toast('Pick a season first, or wait for October', 'error');

  const version = state.latest.release || (releaseVersions()[0] || {}).id;
  if (!version) return toast('Version list is still loading', 'error');

  const name = SEASONS[season].profileName;
  const existing = state.profiles.find((p) => p.name === name);
  if (existing) {
    state.selected = existing.id;
    renderHomeProfiles();
    showView('home');
    return toast(`${name} profile is ready`, 'ok');
  }

  const profile = await window.astra.profiles.save({
    mcVersion: version, loader: 'vanilla', loaderVersion: '', name
  });
  await refreshProfiles(profile.id);
  toast(`Created ${name} on ${version}`, 'ok');
  showView('home');
}

// ---------------------------------------------------------------- version artwork

const artCache = new Map();

async function loadArt(ids) {
  const missing = ids.filter((id) => !artCache.has(id));
  if (missing.length) {
    try {
      const result = await window.astra.artwork.images(missing);
      for (const [id, art] of Object.entries(result)) artCache.set(id, art);
    } catch (_) {
      // No network, or Mojang is down. Cards simply keep their gradient.
      missing.forEach((id) => artCache.set(id, null));
    }
  }
  return ids.map((id) => artCache.get(id) || null);
}

function typeLabel(type) {
  if (type === 'release') return { text: 'Release', cls: '' };
  if (type === 'snapshot') return { text: 'Snapshot', cls: 'snapshot' };
  return { text: type.replace('old_', 'Old '), cls: 'old' };
}

/**
 * Thumbnails are fetched only when a row scrolls into view. With snapshots enabled
 * the list is 900 rows long, and eagerly loading that many images would hammer the
 * CDN for pictures nobody is looking at.
 */
const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    thumbObserver.unobserve(img);
    loadArt([img.dataset.version]).then(([art]) => {
      if (!art || !art.url) return;
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.src = art.url;
    });
  }
}, { rootMargin: '160px' });

function filteredVersions() {
  const needle = ($('#version-filter').value || '').trim().toLowerCase();
  const list = visibleVersions();
  return needle ? list.filter((v) => v.id.toLowerCase().includes(needle)) : list;
}

/** The sidebar list of every version. */
function renderVersionList() {
  const container = $('#version-list');
  const list = filteredVersions();
  const picked = $('#pick-version').value;
  container.innerHTML = '';

  for (const version of list) {
    const row = document.createElement('div');
    row.className = 'version-row' + (version.id === picked ? ' selected' : '');
    row.dataset.version = version.id;

    const thumb = document.createElement('img');
    thumb.className = 'version-thumb';
    thumb.alt = '';
    thumb.dataset.version = version.id;
    thumbObserver.observe(thumb);

    const text = document.createElement('div');
    text.className = 'version-row-text';
    const id = document.createElement('div');
    id.className = 'version-row-id';
    id.textContent = version.id;
    const date = document.createElement('div');
    date.className = 'version-row-date';
    date.textContent = version.releaseTime ? version.releaseTime.slice(0, 10) : '';
    text.append(id, date);

    const badge = typeLabel(version.type);
    const type = document.createElement('span');
    type.className = `version-type ${badge.cls}`;
    type.textContent = badge.text;

    row.append(thumb, text, type);
    row.addEventListener('click', () => selectVersion(version.id));
    container.appendChild(row);
  }

  $('#gallery-note').textContent = list.length === visibleVersions().length
    ? `${list.length} versions`
    : `${list.length} of ${visibleVersions().length} versions`;
}

function selectVersion(id) {
  $('#pick-version').value = id;
  $$('.version-row').forEach((row) => row.classList.toggle('selected', row.dataset.version === id));
  updateVersionDetail(id);
  onVersionChange();
}

async function updateVersionDetail(id) {
  const version = state.versions.find((v) => v.id === id);
  if (!version) return;

  $('#detail-title').textContent = version.id;
  const badge = typeLabel(version.type);
  $('#detail-meta').innerHTML = '';
  const type = document.createElement('span');
  type.className = `version-type ${badge.cls}`;
  type.textContent = badge.text;
  const released = document.createElement('span');
  released.textContent = version.releaseTime
    ? `Released ${new Date(version.releaseTime).toLocaleDateString()}`
    : '';
  $('#detail-meta').append(type, released);

  const [art] = await loadArt([id]);
  const pane = $('#detail-art');
  if (!art || !art.url) {
    pane.style.backgroundImage = '';
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    // Guard against a slow image landing after the user picked something else.
    if ($('#pick-version').value === id) pane.style.backgroundImage = `url("${art.url}")`;
  };
  probe.src = art.url;
}

async function updateHeroArt() {
  const profile = currentProfile();
  const hero = $('#hero-art');
  if (!profile) {
    hero.classList.remove('loaded');
    return;
  }
  const [art] = await loadArt([profile.mcVersion]);
  if (!art || !art.url) {
    hero.classList.remove('loaded');
    return;
  }
  // Preload so the fade-in never shows a half-drawn image.
  const probe = new Image();
  probe.onload = () => {
    hero.style.backgroundImage = `url("${art.url}")`;
    hero.classList.add('loaded');
  };
  probe.src = art.url;
}

// ---------------------------------------------------------------- mod browser

const MOD_CATEGORIES = [
  { id: '', label: 'All' },
  { id: 'horror', label: 'Horror' },
  { id: 'optimization', label: 'Performance' },
  { id: 'utility', label: 'Utility' },
  { id: 'adventure', label: 'Adventure' },
  { id: 'technology', label: 'Tech' },
  { id: 'magic', label: 'Magic' },
  { id: 'decoration', label: 'Decoration' },
  { id: 'library', label: 'Library' }
];

// Shader packs are tagged differently on Modrinth, so the row changes with the type.
const SHADER_CATEGORIES = [
  { id: '', label: 'All' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'vanilla-like', label: 'Vanilla+' },
  { id: 'cartoon', label: 'Cartoon' },
  { id: 'potato', label: 'Low end' },
  { id: 'atmosphere', label: 'Atmosphere' }
];

// Resource packs are tagged by what they change rather than what they add.
const PACK_CATEGORIES = [
  { id: '', label: 'All' },
  { id: 'realistic', label: 'Realistic' },
  { id: 'simplistic', label: 'Simplistic' },
  { id: 'vanilla-like', label: 'Vanilla+' },
  { id: 'decoration', label: 'Decoration' },
  { id: 'gui', label: 'GUI' },
  { id: 'audio', label: 'Audio' },
  { id: 'modded', label: 'Modded' }
];

function isShaders() {
  return state.mods.type === 'shader';
}

function isPacks() {
  return state.mods.type === 'resourcepack';
}

/** Mods are the only kind that cares which loader a profile uses. */
function isLoaderBound() {
  return state.mods.type === 'mod';
}

function categoriesForType() {
  if (isShaders()) return SHADER_CATEGORIES;
  if (isPacks()) return PACK_CATEGORIES;
  return MOD_CATEGORIES;
}

/** The API trio for whichever kind is showing. */
function contentApi() {
  if (isShaders()) return window.astra.shaders;
  if (isPacks()) return window.astra.packs;
  return window.astra.mods;
}

function contentNoun(plural) {
  if (isShaders()) return plural ? 'shaders' : 'shader';
  if (isPacks()) return plural ? 'resource packs' : 'resource pack';
  return plural ? 'mods' : 'mod';
}

/** Switches the whole tab between mods and shader packs. */
function setContentType(type) {
  if (state.mods.type === type) return;
  state.mods.type = type;
  state.mods.category = '';
  state.mods.query = '';
  state.mods.offset = 0;
  state.mods.loaded = false;

  $('#mod-search').value = '';
  $('#mod-search').placeholder = `Search ${contentNoun(true)}`;
  $$('#content-type .type-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.type === type);
  });

  renderModCategories();
  refreshModsTarget();
  renderInstalled();
  runModSearch(true);
}

$$('#content-type .type-btn').forEach(function (btn) {
  btn.addEventListener('click', function () { setContentType(btn.dataset.type); });
});

function currentProfile() {
  return state.profiles.find((p) => p.id === state.selected) || null;
}

function renderModCategories() {
  const bar = $('#mod-categories');
  bar.innerHTML = '';
  for (const category of categoriesForType()) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (state.mods.category === category.id ? ' active' : '');
    btn.textContent = category.label;
    btn.addEventListener('click', () => {
      if (state.mods.category === category.id) return;
      state.mods.category = category.id;
      renderModCategories();
      runModSearch(true);
    });
    bar.appendChild(btn);
  }
}

function refreshModsTarget() {
  const profile = currentProfile();
  const target = $('#mods-target');
  const note = $('#mod-note');
  if (note) {
    note.textContent = isShaders()
      ? 'Shader packs need Iris (Fabric) or OptiFine in the profile to load.'
      : isPacks()
        ? 'Turn a pack on in Options > Resource Packs once the game is running.'
        : '';
  }

  if (!profile) {
    target.innerHTML = 'No profile selected';
  } else if (!isLoaderBound()) {
    // Shaders and resource packs work on any profile, loader or not.
    target.innerHTML = 'Installing into <strong>' + profile.name + '</strong> ('
      + profile.mcVersion + ')';
  } else if (profile.loader === 'vanilla') {
    target.innerHTML = `<strong>${profile.name}</strong> is vanilla - mods need a loader profile`;
  } else {
    target.innerHTML = `Installing into <strong>${profile.name}</strong> `
      + `(${loaderLabel(profile.loader)} ${profile.mcVersion})`;
  }
}

function showModSkeletons() {
  const grid = $('#mod-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton skeleton-card';
    grid.appendChild(card);
  }
}

function compactNumber(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

let searchToken = 0;

async function runModSearch(reset) {
  const profile = currentProfile();
  const mods = state.mods;

  if (reset) {
    mods.offset = 0;
    mods.hits = [];
    showModSkeletons();
  }
  mods.busy = true;
  const token = ++searchToken;

  try {
    const options = {
      query: mods.query,
      category: mods.category,
      sort: mods.sort,
      offset: mods.offset,
      limit: 30,
      gameVersion: profile ? profile.mcVersion : undefined
    };
    // Only mods are loader specific; asking for a loader build of a pack finds nothing.
    if (isLoaderBound() && profile) options.loader = profile.loader;

    const result = await contentApi().search(options);

    // A slower earlier search must not overwrite a newer one.
    if (token !== searchToken) return;

    mods.hits = reset ? result.hits : mods.hits.concat(result.hits);
    mods.total = result.total;
    mods.loaded = true;
    renderMods();
  } catch (err) {
    if (token !== searchToken) return;
    $('#mod-grid').innerHTML = '';
    toast(err.message, 'error');
  } finally {
    if (token === searchToken) mods.busy = false;
  }
}

function renderMods() {
  const grid = $('#mod-grid');
  const { hits, total, installed } = state.mods;
  grid.innerHTML = '';

  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'panel empty-panel';
    empty.innerHTML = '<p>Nothing matched. Try a different search, '
      + 'or pick a profile whose version the mod supports.</p>';
    grid.appendChild(empty);
    $('#btn-mods-more').hidden = true;
    $('#mods-count').textContent = '';
    return;
  }

  for (const mod of hits) {
    const card = document.createElement('div');
    card.className = 'mod-card pop-item';

    const icon = document.createElement('img');
    icon.className = 'mod-icon';
    icon.alt = '';
    if (mod.icon) icon.src = mod.icon;

    const body = document.createElement('div');
    body.className = 'mod-body';

    const title = document.createElement('div');
    title.className = 'mod-title';
    title.textContent = mod.title;

    const author = document.createElement('div');
    author.className = 'mod-author';
    author.textContent = `by ${mod.author}`;

    const desc = document.createElement('div');
    desc.className = 'mod-desc';
    desc.textContent = mod.description;

    const foot = document.createElement('div');
    foot.className = 'mod-foot';

    const downloads = document.createElement('span');
    downloads.className = 'mod-downloads';
    downloads.textContent = `${compactNumber(mod.downloads)} downloads`;

    const tags = document.createElement('div');
    tags.className = 'mod-tags';
    for (const category of mod.categories.slice(0, 2)) {
      const tag = document.createElement('span');
      tag.className = 'mod-tag';
      tag.textContent = category;
      tags.appendChild(tag);
    }

    const already = installed.some((file) => file.toLowerCase().includes(mod.slug.toLowerCase()));
    const install = document.createElement('button');
    install.className = 'install-btn' + (already ? ' done' : '');
    install.textContent = already ? 'Installed' : 'Install';
    install.addEventListener('click', () => installMod(mod, install));

    foot.append(downloads, tags, install);
    body.append(title, author, desc, foot);
    card.append(icon, body);
    grid.appendChild(card);
  }

  popIn(grid, 30);
  $('#mods-count').textContent = `${hits.length} of ${total}`;
  $('#btn-mods-more').hidden = hits.length >= total;
}

async function installMod(mod, button) {
  const profile = currentProfile();
  if (!profile) return toast('Select a profile first', 'error');

  const original = button.textContent;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';

  try {
    const files = await contentApi().install(profile.id, mod.id);
    button.classList.add('done');
    button.textContent = 'Installed';
    const extra = files.length > 1 ? ` (+${files.length - 1} dependency)` : '';
    toast(`Installed ${mod.title}${extra}`, 'ok');
    await renderInstalled();
  } catch (err) {
    button.textContent = original;
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function renderInstalled() {
  const profile = currentProfile();
  const list = $('#installed-list');
  list.innerHTML = '';
  // A vanilla profile can still hold shaders and resource packs; only mods need a loader.
  if (!profile || (profile.loader === 'vanilla' && isLoaderBound())) {
    state.mods.installed = [];
    return;
  }

  const files = await contentApi().installed(profile.id);
  state.mods.installed = files;

  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'installed-row';
    empty.innerHTML = '<span class="installed-name">No mods in this profile yet.</span>';
    list.appendChild(empty);
    return;
  }

  for (const file of files) {
    const disabled = file.endsWith('.disabled');
    const row = document.createElement('div');
    row.className = 'installed-row pop-item' + (disabled ? ' off' : '');

    const name = document.createElement('span');
    name.className = 'installed-name';
    name.textContent = file.replace(/\.disabled$/, '');

    const toggle = document.createElement('button');
    toggle.className = 'ghost-btn small';
    toggle.textContent = disabled ? 'Enable' : 'Disable';
    toggle.addEventListener('click', async () => {
      await window.astra.mods.toggle(profile.id, file);
      await renderInstalled();
    });

    const remove = document.createElement('button');
    remove.className = 'mini-btn danger';
    remove.textContent = '✕';
    remove.title = 'Delete';
    remove.addEventListener('click', async () => {
      await window.astra.mods.remove(profile.id, file);
      toast('Removed');
      await renderInstalled();
      renderMods();
    });

    row.append(name, toggle, remove);
    list.appendChild(row);
  }
  popIn(list, 24);
}

let searchTimer = null;
$('#mod-search').addEventListener('input', (e) => {
  state.mods.query = e.target.value.trim();
  clearTimeout(searchTimer);
  // Debounced, because Modrinth rate limits and every keystroke is a request.
  searchTimer = setTimeout(() => runModSearch(true), 320);
});

$('#version-filter').addEventListener('input', () => renderVersionList());

$('#mod-sort').addEventListener('change', (e) => {
  state.mods.sort = e.target.value;
  runModSearch(true);
});

$('#btn-mods-more').addEventListener('click', () => {
  state.mods.offset += 30;
  runModSearch(false);
});

window.astra.mods.onProgress(({ title }) => {
  if (title) $('#mods-count').textContent = `Downloading ${title}`;
});

// ---------------------------------------------------------------- wardrobe

const wardrobe = { owned: [], builtIn: [], selected: null, equipped: {}, coins: 0 };

function cosmeticUrl(item) {
  return `../assets/${item.asset}`;
}

/**
 * The player model, seen from behind, wearing a cape.
 *
 * Back view because that is the only angle a cape is visible from. Each body part is a
 * window onto the 64x64 skin at 8x, so nothing has to be decoded or redrawn - the
 * browser just offsets one image seven times.
 */
const SCALE = 8;

// Front by default. A cape sits behind you, so the toggle matters for previewing one.
let modelFacing = 'front';

/**
 * Where each body part lives in the 64x64 skin: [class, x, y, width, height].
 *
 * Two things matter here and both were wrong before. Arm width is per skin - slim (Alex)
 * arms are 3px, classic (Steve) 4px - and slicing 4 out of a slim skin drags in a column
 * of the neighbouring face. And every part has a second *overlay* layer holding the hat,
 * jacket and sleeves; skipping it loses most of the detail on a lot of skins.
 */
function skinParts(slim, back) {
  const arm = slim ? 3 : 4;

  // [class, base x, base y, overlay x, overlay y, w, h]
  const front = [
    ['mc-head', 8, 8, 40, 8, 8, 8],
    ['mc-body', 20, 20, 20, 36, 8, 12],
    ['mc-arm-r', 44, 20, 44, 36, arm, 12],
    ['mc-arm-l', 36, 52, 52, 52, arm, 12],
    ['mc-leg-r', 4, 20, 4, 36, 4, 12],
    ['mc-leg-l', 20, 52, 4, 52, 4, 12]
  ];

  const rear = [
    ['mc-head', 24, 8, 56, 8, 8, 8],
    ['mc-body', 32, 20, 32, 36, 8, 12],
    ['mc-arm-r', slim ? 51 : 52, 20, slim ? 51 : 52, 36, arm, 12],
    ['mc-arm-l', slim ? 43 : 44, 52, slim ? 59 : 60, 52, arm, 12],
    ['mc-leg-r', 12, 20, 12, 36, 4, 12],
    ['mc-leg-l', 28, 52, 12, 52, 4, 12]
  ];

  return back ? rear : front;
}

/**
 * The signed-in account's own skin.
 *
 * Mojang hands the exact texture URL back with the profile at sign-in, so that is used
 * first - it is authoritative and needs no third party. It arrives as `http://` and the
 * page only permits `https:`, hence the rewrite. mc-heads by UUID is the fallback, and a
 * default skin stands in when nobody is signed in.
 */
function activeSkin() {
  const account = state.settings.account;
  if (!account) {
    return { url: 'https://mc-heads.net/skin/MHF_Steve', slim: false, name: null };
  }

  const skins = account.skins || [];
  const active = skins.find((s) => s.state === 'ACTIVE') || skins[0];
  const slim = Boolean(active && String(active.variant).toUpperCase() === 'SLIM');

  return {
    url: active && active.url
      ? active.url.replace(/^http:\/\//i, 'https://')
      : `https://mc-heads.net/skin/${account.id}`,
    slim,
    name: account.name
  };
}

/** Builds the model into a container, wearing `item` (or nothing). */
function buildModel(container, item) {
  container.innerHTML = '';

  const model = document.createElement('div');
  model.className = 'mc-model';

  const skin = activeSkin();
  const back = modelFacing === 'back';
  model.title = skin.name ? `${skin.name}'s skin` : 'Sign in to see your own skin';

  for (const [cls, sx, sy, ox, oy, w, h] of skinParts(skin.slim, back)) {
    const place = (x, y, overlay) => {
      const part = document.createElement('div');
      part.className = `mc-part ${cls}${overlay ? ' mc-overlay' : ''}`;
      part.style.backgroundImage = `url("${skin.url}")`;
      part.style.backgroundPosition = `-${x * SCALE}px -${y * SCALE}px`;
      // Clip to just this face; the div's own size does the cropping.
      part.style.width = `${w * SCALE}px`;
      part.style.height = `${h * SCALE}px`;
      // Slim arms are a pixel narrower, so keep them against the body.
      if (skin.slim) {
        if (cls === 'mc-arm-r') part.style.left = `${SCALE}px`;
        if (cls === 'mc-arm-l') part.style.left = `${96}px`;
      }
      model.appendChild(part);
    };
    place(sx, sy, false);
    place(ox, oy, true);
  }

  const cape = document.createElement('div');
  cape.className = 'mc-cape' + (item ? '' : ' none') + (back ? '' : ' behind');
  if (item) {
    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = cosmeticUrl(item);
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      cape.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = cosmeticUrl(item);
      img.alt = '';
      cape.appendChild(img);
    }
  }
  model.appendChild(cape);
  container.appendChild(model);

  const toggle = document.createElement('div');
  toggle.className = 'facing-toggle';
  for (const side of ['front', 'back']) {
    const btn = document.createElement('button');
    btn.className = 'facing-btn' + (modelFacing === side ? ' active' : '');
    btn.textContent = side === 'front' ? 'Front' : 'Back';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelFacing = side;
      // Rebuild every model on screen so they stay in step.
      buildModel(container, item);
      const stage = $('#cape-stage');
      if (stage && stage !== container) buildModel(stage, findCosmetic(wardrobe.selected));
    });
    toggle.appendChild(btn);
  }
  container.appendChild(toggle);
}

/** Wardrobe preview: your player, from behind, wearing the selected cape. */
function renderCapePreview(item) {
  const stage = $('#cape-stage');
  stage.className = 'model-stage';
  buildModel(stage, item);
  $('#preview-name').textContent = item ? item.name : 'Nothing equipped';
}

function cosmeticCard(item, owned) {
  const card = document.createElement('div');
  card.className = 'cosmetic-card pop-item' + (wardrobe.selected === item.id ? ' selected' : '');

  const thumb = document.createElement('div');
  thumb.className = 'cosmetic-thumb';

  if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = cosmeticUrl(item);
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    // Only play on hover; a grid of autoplaying videos is a lot of decode work.
    card.addEventListener('mouseenter', () => video.play().catch(() => {}));
    card.addEventListener('mouseleave', () => video.pause());
    thumb.appendChild(video);
    const badge = document.createElement('span');
    badge.className = 'live-badge';
    badge.textContent = 'Live';
    thumb.appendChild(badge);
  } else {
    const img = document.createElement('img');
    img.src = cosmeticUrl(item);
    img.alt = '';
    thumb.appendChild(img);
    if (item.effect) {
      const badge = document.createElement('span');
      badge.className = 'live-badge';
      badge.textContent = 'Live';
      thumb.appendChild(badge);
    }
  }

  const meta = document.createElement('div');
  meta.className = 'cosmetic-meta';
  const name = document.createElement('div');
  name.className = 'cosmetic-name';
  name.textContent = item.name;
  const sub = document.createElement('div');
  sub.className = 'cosmetic-sub';
  if (item.rarity) {
    const rarity = document.createElement('span');
    rarity.className = `rarity ${item.rarity}`;
    rarity.textContent = item.rarity;
    sub.appendChild(rarity);
  }
  meta.append(name, sub);
  card.append(thumb, meta);

  card.addEventListener('click', () => {
    wardrobe.selected = item.id;
    renderCapePreview(item);
    renderOwned();
  });
  return card;
}

function allCosmetics() {
  return wardrobe.builtIn;
}

function findCosmetic(id) {
  return allCosmetics().find((item) => item.id === id) || null;
}

function renderOwned() {
  const grid = $('#owned-grid');
  grid.innerHTML = '';

  const available = wardrobe.builtIn.filter((item) => wardrobe.owned.includes(item.id));

  if (!available.length) {
    grid.innerHTML = '<p class="hint-block">No capes yet. Earn coins from the daily '
      + 'challenges, then buy one in the Shop.</p>';
    return;
  }
  for (const item of available) grid.appendChild(cosmeticCard(item, true));
  popIn(grid, 30);
}

async function refreshWardrobe() {
  const lists = await window.astra.cosmetics.list();
  wardrobe.builtIn = lists.builtIn;

  try {
    const state_ = await window.astra.api.me();
    wardrobe.owned = state_.player.cosmetics || [];
    wardrobe.equipped = state_.player.equipped || {};
    wardrobe.coins = state_.player.coins || 0;
  } catch (_) {
    // Offline: custom capes still work, bought ones simply are not known.
    wardrobe.owned = [];
    wardrobe.equipped = {};
  }

  $('#wardrobe-coins').textContent = `${wardrobe.coins} coins`;
  if (!wardrobe.selected && wardrobe.equipped.cape) wardrobe.selected = wardrobe.equipped.cape;
  renderOwned();
  renderCapePreview(findCosmetic(wardrobe.selected));
}

$('#btn-equip').addEventListener('click', async () => {
  const item = findCosmetic(wardrobe.selected);
  if (!item) return toast('Pick a cape first', 'error');
  try {
    await window.astra.api.equip('cape', item.id);
    wardrobe.equipped.cape = item.id;
    toast(`Equipped ${item.name}`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-unequip').addEventListener('click', async () => {
  wardrobe.selected = null;
  renderCapePreview(null);
  try { await window.astra.api.equip('cape', null); } catch (_) { /* offline is fine */ }
});

// ---------------------------------------------------------------- shop

async function refreshShop() {
  try {
    const data = await window.astra.api.shop();
    $('#shop-coins').textContent = `${data.player.coins} coins`;
    const season = data.items.find((item) => item.seasonal && item.available);
    $('#season-note').textContent = season
      ? `${season.seasonal} items are in season`
      : 'Seasonal items return in October and December';
    renderShopGrid(data.items, data.player);
  } catch (err) {
    $('#shop-grid').innerHTML =
      `<div class="panel empty-panel"><p>${err.message}. Start the Astra server, `
      + 'or set its address in Settings.</p></div>';
  }
  refreshChallenges();
  refreshDaily();
}

function renderShopGrid(items, player) {
  const grid = $('#shop-grid');
  grid.innerHTML = '';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'cosmetic-card shop-card pop-item';

    const thumb = document.createElement('div');
    thumb.className = 'cosmetic-thumb';
    const asset = `../assets/${item.asset}`;
    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = asset;
      video.loop = true; video.muted = true; video.playsInline = true;
      card.addEventListener('mouseenter', () => video.play().catch(() => {}));
      card.addEventListener('mouseleave', () => video.pause());
      thumb.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = asset;
      img.alt = '';
      thumb.appendChild(img);
    }
    if (item.kind !== 'image') {
      const badge = document.createElement('span');
      badge.className = 'live-badge';
      badge.textContent = 'Live';
      thumb.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'cosmetic-meta';
    const name = document.createElement('div');
    name.className = 'cosmetic-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'cosmetic-sub';
    const rarity = document.createElement('span');
    rarity.className = `rarity ${item.rarity}`;
    rarity.textContent = item.rarity;
    sub.appendChild(rarity);
    meta.append(name, sub);

    const foot = document.createElement('div');
    foot.className = 'shop-foot';
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = item.free ? 'Free' : String(item.price);

    const owned = (player.cosmetics || []).includes(item.id);
    const buy = document.createElement('button');
    buy.className = 'buy-btn' + (owned ? ' owned' : '');
    buy.textContent = owned ? 'Owned'
      : !item.available ? 'Out of season'
        : item.free ? 'Claim' : 'Buy';
    buy.disabled = owned || !item.available;
    buy.addEventListener('click', async () => {
      buy.disabled = true;
      try {
        const result = await window.astra.api.buy(item.id);
        toast(`Bought ${result.bought.name}`, 'ok');
        refreshShop();
        refreshWardrobe();
      } catch (err) {
        toast(err.message, 'error');
        buy.disabled = false;
      }
    });

    foot.append(price, buy);
    card.append(thumb, meta, foot);
    // Clicking anywhere except the buy button previews it on your own skin.
    card.addEventListener('click', (e) => {
      if (e.target.closest('.buy-btn')) return;
      openCapePreview(item, owned, player);
    });
    grid.appendChild(card);
  }
  popIn(grid, 30);
}

/** Full-screen preview of one cape on your own player, with buying from inside it. */
function openCapePreview(item, owned, player) {
  const existing = $('.overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const card = document.createElement('div');
  card.className = 'overlay-card';

  const head = document.createElement('div');
  head.className = 'overlay-head';
  const title = document.createElement('span');
  title.className = 'overlay-title';
  title.textContent = item.name;
  const rarity = document.createElement('span');
  rarity.className = `rarity ${item.rarity}`;
  rarity.textContent = item.rarity;
  const close = document.createElement('button');
  close.className = 'overlay-close';
  close.textContent = '✕';
  head.append(title, rarity, close);

  const body = document.createElement('div');
  body.className = 'overlay-body';

  const left = document.createElement('div');
  const desc = document.createElement('p');
  desc.className = 'overlay-desc';
  desc.textContent = item.description || '';
  const hint = document.createElement('p');
  hint.className = 'model-hint';
  hint.style.textAlign = 'left';
  hint.style.marginTop = '10px';
  hint.textContent = state.settings.account
    ? `Shown on ${state.settings.account.name}, from behind - where a cape actually sits.`
    : 'Sign in to see it on your own skin.';
  left.append(desc, hint);

  const stage = document.createElement('div');
  stage.className = 'model-stage';
  stage.style.minHeight = '300px';
  buildModel(stage, item);

  body.append(left, stage);

  const foot = document.createElement('div');
  foot.className = 'overlay-foot';
  const price = document.createElement('span');
  price.className = 'price';
  price.textContent = owned ? 'Owned' : item.free ? 'Free' : `${item.price} coins`;

  const action = document.createElement('button');
  action.className = 'buy-btn' + (owned ? ' owned' : item.free ? ' free' : '');
  action.textContent = owned ? 'Equip'
    : !item.available ? 'Out of season'
      : item.free ? 'Claim' : 'Buy';
  action.disabled = !owned && !item.available;

  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      if (owned) {
        await window.astra.api.equip('cape', item.id);
        toast(`Equipped ${item.name}`, 'ok');
        refreshWardrobe();
      } else {
        await window.astra.api.buy(item.id);
        toast(item.free ? `Claimed ${item.name}` : `Bought ${item.name}`, 'ok');
        refreshShop();
        refreshWardrobe();
      }
      overlay.remove();
    } catch (err) {
      toast(err.message, 'error');
      action.disabled = false;
    }
  });

  foot.append(price, action);
  card.append(head, body, foot);
  overlay.appendChild(card);

  const dismiss = () => overlay.remove();
  close.addEventListener('click', dismiss);
  // Clicking the backdrop closes; clicking the card must not.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); }
  });

  document.body.appendChild(overlay);
}

/** The once-a-day coin claim shown above the challenges. */
async function refreshDaily() {
  const panel = $('#daily-panel');
  const button = $('#btn-daily');
  const streak = $('#daily-streak');
  if (!panel) return;

  try {
    const data = await window.astra.api.daily();
    streak.textContent = data.streak ? `${data.streak} day streak` : 'No streak yet';
    if (data.claimed) {
      $('#daily-sub').textContent = `Claimed today. Tomorrow is worth ${data.next} coins.`;
      button.textContent = 'Claimed';
      button.disabled = true;
    } else {
      $('#daily-sub').textContent = `${data.next} coins waiting for you.`;
      button.textContent = `Claim ${data.next}`;
      button.disabled = false;
    }
  } catch (_) {
    $('#daily-sub').textContent = 'Needs the Astra server running.';
    button.disabled = true;
  }
}

$('#btn-daily').addEventListener('click', async () => {
  const button = $('#btn-daily');
  button.disabled = true;
  try {
    const result = await window.astra.api.dailyClaim();
    toast(`+${result.reward} coins - ${result.streak} day streak`, 'ok');
    refreshShop();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
});

async function refreshChallenges() {
  const list = $('#challenge-list');
  try {
    const data = await window.astra.api.challenges();
    $('#challenge-day').textContent = data.day;
    list.innerHTML = '';

    for (const challenge of data.challenges) {
      const row = document.createElement('div');
      row.className = 'challenge pop-item';

      const text = document.createElement('div');
      text.className = 'challenge-text';
      const title = document.createElement('div');
      title.className = 'challenge-title';
      title.textContent = challenge.text;
      const bar = document.createElement('div');
      bar.className = 'challenge-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round((challenge.progress / challenge.goal) * 100)}%`;
      bar.appendChild(fill);
      const num = document.createElement('div');
      num.className = 'challenge-num';
      num.textContent = `${challenge.progress} / ${challenge.goal}`;
      text.append(title, bar, num);

      const reward = document.createElement('span');
      reward.className = 'challenge-reward';
      reward.textContent = `+${challenge.reward}`;

      const claim = document.createElement('button');
      claim.className = 'ghost-btn small';
      claim.textContent = challenge.claimed ? 'Claimed' : 'Claim';
      claim.disabled = !challenge.complete || challenge.claimed;
      claim.addEventListener('click', async () => {
        try {
          const result = await window.astra.api.claim(challenge.id);
          toast(`+${result.reward} coins`, 'ok');
          refreshShop();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      row.append(text, reward, claim);
      list.appendChild(row);
    }
    popIn(list, 40);
  } catch (_) {
    list.innerHTML = '<p class="hint-block">Challenges need the Astra server running.</p>';
  }
}

// ---------------------------------------------------------------- friends

async function refreshFriends() {
  const list = $('#friend-list');
  const status = $('#friends-status');

  try {
    const data = await window.astra.api.friends();
    list.innerHTML = '';

    const incoming = data.friends.filter((f) => f.state === 'incoming').length;
    $('#friends-dot').hidden = incoming === 0;
    status.textContent = data.friends.length
      ? `${data.friends.filter((f) => f.state === 'friend').length} friends`
        + (incoming ? `, ${incoming} waiting on you` : '')
      : 'Nobody yet';

    if (!data.friends.length) {
      list.innerHTML = '<div class="panel empty-panel"><p>Add someone by their Minecraft '
        + 'name above. They need Astra too.</p></div>';
      return;
    }

    for (const friend of data.friends) list.appendChild(friendRow(friend));
    popIn(list, 30);
  } catch (err) {
    status.textContent = '';
    list.innerHTML = `<div class="panel empty-panel"><p>${err.message}</p>`
      + '<p>Start it with <code>npm run server</code>, or set the address in Settings.</p></div>';
  }
}

function friendRow(friend) {
  const row = document.createElement('div');
  row.className = 'friend-row pop-item';

  const head = document.createElement('img');
  head.className = 'friend-head';
  head.src = `https://mc-heads.net/avatar/${friend.uuid}/48`;
  head.alt = '';

  const info = document.createElement('div');
  info.className = 'friend-info';

  const name = document.createElement('div');
  name.className = 'friend-name';
  const dot = document.createElement('span');
  const presence = friend.presence || {};
  dot.className = 'dot' + (presence.server ? ' ingame' : presence.status === 'online' ? ' online' : '');
  name.append(dot, document.createTextNode(friend.name));
  if (friend.tier) {
    const tier = document.createElement('span');
    tier.className = 'tier-badge';
    tier.textContent = friend.tier;
    name.appendChild(tier);
  }

  const where = document.createElement('div');
  where.className = 'friend-where';
  where.textContent = friend.state === 'incoming' ? 'Wants to be your friend'
    : friend.state === 'outgoing' ? 'Request sent'
      : presence.server ? `On ${presence.server}${presence.version ? ` - ${presence.version}` : ''}`
        : presence.status === 'online' ? 'In the launcher' : 'Offline';
  info.append(name, where);

  const actions = document.createElement('div');
  actions.className = 'profile-actions';

  if (friend.state === 'incoming') {
    const accept = document.createElement('button');
    accept.className = 'primary-btn';
    accept.textContent = 'Accept';
    accept.addEventListener('click', async () => {
      await window.astra.api.friendAccept(friend.uuid);
      toast(`${friend.name} is now your friend`, 'ok');
      refreshFriends();
    });
    actions.appendChild(accept);
  } else if (presence.joinable && presence.server) {
    const join = document.createElement('button');
    join.className = 'primary-btn';
    join.textContent = 'Join';
    join.addEventListener('click', () => joinFriend(friend));
    actions.appendChild(join);
  }

  const remove = document.createElement('button');
  remove.className = 'mini-btn danger';
  remove.textContent = '✕';
  remove.title = 'Remove';
  remove.addEventListener('click', async () => {
    await window.astra.api.friendRemove(friend.uuid);
    refreshFriends();
  });
  actions.appendChild(remove);

  row.append(head, info, actions);
  return row;
}

/** Launches straight onto whatever server the friend is on. */
async function joinFriend(friend) {
  const presence = friend.presence || {};
  if (!presence.server) return toast(`${friend.name} is not on a server`, 'error');

  const match = state.profiles.find((p) => p.mcVersion === presence.version);
  if (!match) {
    return toast(`You need a ${presence.version} profile to join ${friend.name}`, 'error');
  }
  state.selected = match.id;
  renderHomeProfiles();
  toast(`Joining ${friend.name} on ${presence.server}`, 'ok');
  showView('home');
  $('#btn-play').click();
}

$('#btn-add-friend').addEventListener('click', async () => {
  const name = $('#friend-name').value.trim();
  if (!name) return toast('Type a Minecraft name', 'error');
  try {
    await window.astra.api.friendAdd(name);
    $('#friend-name').value = '';
    toast(`Request sent to ${name}`, 'ok');
    refreshFriends();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-refresh-friends').addEventListener('click', refreshFriends);

// ---- profile sharing ----

$('#btn-share-profile').addEventListener('click', async () => {
  const profile = currentProfile();
  if (!profile) return toast('Select a profile first', 'error');

  try {
    const mods = await window.astra.mods.installed(profile.id);
    const result = await window.astra.api.share({
      name: profile.name,
      loader: profile.loader,
      loaderVersion: profile.loaderVersion,
      mcVersion: profile.mcVersion,
      mods
    });
    const box = $('#share-code');
    box.hidden = false;
    box.textContent = result.code;
    box.title = 'Click to copy';
    box.onclick = () => {
      navigator.clipboard.writeText(result.code);
      toast('Code copied', 'ok');
    };
    toast(`Share code: ${result.code}`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-import-code').addEventListener('click', async () => {
  const code = $('#import-code').value.trim().toUpperCase();
  if (!code) return toast('Paste a code first', 'error');

  try {
    const shared = await window.astra.api.shared(code);
    const profile = await window.astra.profiles.save({
      mcVersion: shared.payload.mcVersion,
      loader: shared.payload.loader,
      loaderVersion: shared.payload.loaderVersion,
      name: `${shared.payload.name} (shared)`
    });
    await refreshProfiles(profile.id);
    $('#import-code').value = '';
    const count = (shared.payload.mods || []).length;
    toast(`Imported ${shared.name}${count ? ` - ${count} mods listed` : ''}`, 'ok');
    showView('home');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------------------------------------------------------------- servers

let serverList = [];

async function refreshServers() {
  const saved = state.settings.serverList || [];
  let partnered = [];
  try {
    const data = await window.astra.api.servers();
    partnered = data.servers || [];
  } catch (_) {
    // Offline: the partnered list is the only thing lost, saved servers still show.
    partnered = [{
      name: 'Hexavox', address: 'play.hexavox.online', partnered: true,
      tags: ['Partnered'], description: 'Official Astra partner server.'
    }];
  }

  const seen = new Set(partnered.map((s) => s.address));
  serverList = [...partnered, ...saved.filter((s) => !seen.has(s.address))];
  renderServers();
  pingServers();
}

function renderServers() {
  const list = $('#server-list');
  list.innerHTML = '';

  serverList.forEach((server, index) => {
    const row = document.createElement('div');
    row.className = 'server-row pop-item' + (server.partnered ? ' partnered' : '');
    row.draggable = true;
    row.dataset.index = String(index);

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⋮⋮';

    const info = document.createElement('div');
    info.className = 'server-info';
    const name = document.createElement('div');
    name.className = 'server-name';
    name.textContent = server.name || server.address;
    if (server.partnered) {
      const badge = document.createElement('span');
      badge.className = 'partner-badge';
      badge.textContent = 'Partner';
      name.appendChild(badge);
    }
    const address = document.createElement('div');
    address.className = 'server-address';
    address.textContent = server.description
      ? `${server.address} - ${server.description}`
      : server.address;
    info.append(name, address);

    const ping = document.createElement('span');
    ping.className = 'server-ping';
    ping.id = `ping-${index}`;
    ping.textContent = '...';

    const copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.textContent = '⧉';
    copy.title = 'Copy address';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(server.address);
      toast('Address copied', 'ok');
    });

    row.append(handle, info, ping, copy);

    if (!server.partnered) {
      const remove = document.createElement('button');
      remove.className = 'mini-btn danger';
      remove.textContent = '✕';
      remove.addEventListener('click', async () => {
        state.settings.serverList = (state.settings.serverList || [])
          .filter((s) => s.address !== server.address);
        await window.astra.settings.set({ serverList: state.settings.serverList });
        refreshServers();
      });
      row.appendChild(remove);
    }

    wireDrag(row);
    list.appendChild(row);
  });
  popIn(list, 30);
}

/** Drag to reorder. Partnered entries can move too; the order is the player's. */
function wireDrag(row) {
  row.addEventListener('dragstart', (e) => {
    row.classList.add('dragging');
    e.dataTransfer.setData('text/plain', row.dataset.index);
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    $$('.server-row').forEach((r) => r.classList.remove('drop-target'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    const from = Number(e.dataTransfer.getData('text/plain'));
    const to = Number(row.dataset.index);
    if (Number.isNaN(from) || from === to) return;

    const moved = serverList.splice(from, 1)[0];
    serverList.splice(to, 0, moved);
    state.settings.serverList = serverList.filter((s) => !s.partnered);
    await window.astra.settings.set({ serverList: state.settings.serverList });
    renderServers();
    pingServers();
  });
}

async function pingServers() {
  for (let i = 0; i < serverList.length; i++) {
    const cell = document.getElementById(`ping-${i}`);
    if (!cell) continue;
    window.astra.perf.ping(serverList[i].address).then((result) => {
      const el = document.getElementById(`ping-${i}`);
      if (!el) return;
      el.textContent = result.reachable ? `${result.ms} ms` : 'offline';
      el.style.color = !result.reachable ? 'var(--danger)'
        : result.ms < 80 ? 'var(--ok)' : result.ms < 200 ? 'var(--moon)' : '#F0C85A';
    }).catch(() => {});
  }
}

$('#btn-add-server').addEventListener('click', async () => {
  const address = $('#server-address').value.trim();
  if (!address) return toast('Type a server address', 'error');

  const saved = state.settings.serverList || [];
  if (saved.some((s) => s.address === address)) return toast('That one is already listed', 'error');

  saved.push({ name: address, address });
  state.settings.serverList = saved;
  await window.astra.settings.set({ serverList: saved });
  $('#server-address').value = '';
  refreshServers();
});

// ---------------------------------------------------------------- patch notes

// What changed in Astra itself. Newest first.
const ASTRA_NOTES = [
  {
    version: '1.3.0',
    date: '2026-08-31',
    title: 'It fixes itself',
    items: [
      'When Minecraft crashes, Astra reads the log and names the mod that did it.',
      'One button applies the fix: turn the mod off, or download what was missing.',
      'A mod built for the wrong version is swapped for the build that matches.',
      'Missing dependencies like Fabric API are fetched automatically.',
      'Mods are checked before you play, so a jar that cannot load is caught early.',
      'Out of memory and Java version problems are explained and fixed too.'
    ]
  },
  {
    version: '1.2.0',
    date: '2026-08-31',
    title: 'Horror tab',
    items: [
      'New Horror category in the Mods tab - hundreds of real scary mods in one place.',
      'From The Fog, The Man From The Fog, Cave Dweller, Backrooms, Sculk Horde and more.',
      'Filtered by hand, so a mod that merely mentions monsters does not show up.',
      'Everything installs from Modrinth, which moderates and scans what it hosts.',
      'The build now refuses to package JavaScript that does not parse.'
    ]
  },
  {
    version: '1.1.0',
    date: '2026-08-31',
    title: 'Capes in game',
    items: [
      'Your wardrobe cape now renders on your player in Minecraft, animated.',
      'Every cape is baked into a 16 frame loop, so it moves the same in game as in the store.',
      'Astra menus are translucent - the game shows through instead of being boxed out.',
      'New buttons on the Astra main menu, and a switch to put the vanilla menu back.',
      'The in-game menu (Right Shift) has the same switch, so it is never a one-way door.'
    ]
  },
  {
    version: '1.0.0',
    date: '2026-08-31',
    title: 'Astra Client',
    items: [
      'Renamed from Luna, with a new icon and splash.',
      'Snapshots install correctly - native libraries are now matched to your CPU architecture.',
      'Old versions work: the right Java runtime is downloaded automatically, so 1.8 and 1.12 launch.',
      'Shaders tab, browsing every shader pack on Modrinth.',
      'Wardrobe with live capes, and you can make your own from a picture or video.',
      'Shop, daily challenges and coins.',
      'Friends, with joining straight into their server.',
      'Share a whole mod profile with a short code.',
      'Server browser with drag-to-reorder and real latency.',
      'Discord presence showing what you are playing.',
      'In-app updates that download only what changed.'
    ]
  }
];

async function renderNotes() {
  const list = $('#notes-list');
  list.innerHTML = '';
  $('#notes-version').textContent = `You are on ${await window.astra.update.version()}`;

  for (const note of ASTRA_NOTES) {
    const card = document.createElement('div');
    card.className = 'note-card pop-item';

    const head = document.createElement('div');
    head.className = 'note-head';
    const version = document.createElement('span');
    version.className = 'note-version';
    version.textContent = `Astra ${note.version} - ${note.title}`;
    const date = document.createElement('span');
    date.className = 'note-date';
    date.textContent = note.date;
    head.append(version, date);

    const body = document.createElement('div');
    body.className = 'note-body';
    const ul = document.createElement('ul');
    for (const item of note.items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    body.appendChild(ul);

    card.append(head, body);
    list.appendChild(card);
  }

  // Then Minecraft's own notes, so both live in one place.
  try {
    const news = await window.astra.artwork.news(6);
    for (const entry of news) {
      const card = document.createElement('div');
      card.className = 'note-card pop-item';
      const head = document.createElement('div');
      head.className = 'note-head';
      const title = document.createElement('span');
      title.className = 'note-version';
      title.textContent = entry.title;
      const date = document.createElement('span');
      date.className = 'note-date';
      date.textContent = (entry.date || '').slice(0, 10);
      head.append(title, date);

      const body = document.createElement('div');
      body.className = 'note-body';
      body.textContent = entry.text || '';

      card.append(head, body);
      if (entry.link) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => window.astra.shell.open(entry.link));
      }
      list.appendChild(card);
    }
  } catch (_) {
    // Mojang's feed being down is not worth an error here.
  }
  popIn(list, 40);
}

// ---------------------------------------------------------------- updates

let pendingUpdate = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function refreshUpdatePanel() {
  const version = await window.astra.update.version();
  $('#update-version').textContent = `Astra Client ${version}`;

  const repo = await window.astra.update.repo();
  $('#update-owner').value = repo.owner === 'YOUR-GITHUB-USERNAME' ? '' : repo.owner;
  $('#update-repo').value = repo.repo || '';

  const applied = await window.astra.update.applied();
  if (applied) toast(`Updated to ${applied}`, 'ok');
}

async function checkForUpdates(loud) {
  const status = $('#update-status');
  status.textContent = 'Checking...';
  $('#btn-install-update').hidden = true;
  $('#btn-restart').hidden = true;

  const info = await window.astra.update.check();
  pendingUpdate = info;

  if (!info.available) {
    const messages = {
      'no-repo': 'Set a GitHub repo below to receive updates',
      'not-published': `No release published to ${info.repo} yet - you are on ${info.current}`,
      unreachable: `Could not reach GitHub (${info.error || 'offline'})`,
      'up-to-date': `Up to date (${info.current})`
    };
    status.textContent = messages[info.reason] || `Up to date (${info.current})`;
    if (loud && info.reason === 'up-to-date') toast('You are on the newest version', 'ok');
    return;
  }

  if (info.needsFullInstall) {
    status.textContent = `${info.version} needs a full reinstall (the Electron runtime changed)`;
    if (info.downloads && info.downloads.setup) {
      $('#btn-install-update').hidden = false;
      $('#btn-install-update').textContent = 'Download installer';
    }
    return;
  }

  status.textContent = `${info.version} is available - ${formatBytes(info.bytes)} to download`;
  $('#btn-install-update').hidden = false;
  $('#btn-install-update').textContent = 'Install';
  if (loud) toast(`Update ${info.version} available`, 'ok');
}

$('#btn-check-update').addEventListener('click', () => checkForUpdates(true));

$('#btn-install-update').addEventListener('click', async () => {
  if (!pendingUpdate || !pendingUpdate.available) return;

  // A runtime bump cannot be swapped in place; hand them the installer instead.
  if (pendingUpdate.needsFullInstall) {
    const url = pendingUpdate.downloads && pendingUpdate.downloads.setup;
    if (url) window.astra.shell.open(url);
    return;
  }

  const button = $('#btn-install-update');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    await window.astra.update.download(pendingUpdate);
    $('#update-status').textContent = `${pendingUpdate.version} is ready - restart to finish`;
    button.hidden = true;
    $('#btn-restart').hidden = false;
    toast('Update downloaded. Restart to apply it.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
    button.textContent = 'Install';
  } finally {
    button.disabled = false;
  }
});

$('#btn-restart').addEventListener('click', () => window.astra.update.restart());

$('#btn-save-repo').addEventListener('click', async () => {
  const owner = $('#update-owner').value.trim();
  const repo = $('#update-repo').value.trim() || 'astra-client';
  if (!owner) return toast('Enter the GitHub username that hosts the repo', 'error');

  await window.astra.update.repo({ owner, repo });
  toast(`Updates will come from ${owner}/${repo}`, 'ok');
  checkForUpdates(false);
});

window.astra.update.onProgress(({ done, total, label }) => {
  $('#update-status').textContent = total
    ? `Downloading ${done}/${total} - ${label}`
    : `Downloading ${label}`;
});

$('#btn-invite').addEventListener('click', () => {
  toast('Friends and invites arrive with the Astra backend');
  showView('friends');
});

// ---------------------------------------------------------------- boot

(async function boot() {
  await runSplash([
    ['Reading settings', async () => {
      state.settings = await window.astra.settings.get();
    }],
    ['Contacting Mojang', async () => {
      const data = await window.astra.versions.list();
      state.versions = data.versions;
      state.latest = data.latest;
    }],
    ['Loading profiles', async () => {
      state.profiles = await window.astra.profiles.list();
    }],
    ['Preparing the launcher', async () => {
      if (!state.settings) state.settings = {};
      bindSettings();
      renderAccount();
      applyBackground();
      applyMusic();
      renderPills();
      renderVersionSelect();
      renderModCategories();
      renderBackgroundPicker();
      applyBackground();
      applySeason();
      await refreshProfiles();

      // Park the rail marker on the starting tab and animate the first view in.
      moveIndicator($$('.rail-btn').find((b) => b.dataset.view === currentView));
      popIn($('.view.active'));
      renderVersionList();
      updateHeroArt();
      await refreshUpdatePanel();
    }],
    ['Checking mod loaders', async () => {
      if ($('#pick-version').value) await onVersionChange();
    }],
    ['Looking for updates', async () => {
      // Quiet on purpose: nobody wants a popup every launch saying nothing changed.
      await checkForUpdates(false);
    }],
    ['Connecting to Astra', async () => {
      // Silent: the launcher works fine with the backend off, so a failure here is
      // not something to interrupt startup for.
      await connectAstra(true);
      const connected = await window.astra.discord.state();
      const discordState = $('#discord-state');
      if (discordState) {
        discordState.textContent = state.settings.discordEnabled === false ? 'Off'
          : connected ? 'Connected to Discord' : 'Discord is not running';
      }
    }]
  ]);
})();
