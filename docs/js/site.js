/* Astra site. Two jobs: look up a shared profile code, and point the download
   buttons at whatever the newest release actually is. */

(function () {
  'use strict';

  var REPO = 'justthatguypal/ASTRAClient-';
  // When the site is served by the Astra backend the API is same-origin. Opened as a
  // static page (GitHub Pages, or a file), fall back to a local server if one is up.
  var API = location.protocol.startsWith('http') && location.port !== ''
    ? ''
    : 'http://localhost:8787';

  // ---------------------------------------------------------------- shared codes

  var input = document.getElementById('code-input');
  var button = document.getElementById('code-go');
  var result = document.getElementById('code-result');

  function escape(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function show(html, isError) {
    result.hidden = false;
    result.className = 'code-result' + (isError ? ' error' : '');
    result.innerHTML = html;
  }

  function lookup() {
    var code = (input.value || '').trim().toUpperCase();
    if (!code) {
      show('<h4>Type a code first</h4>'
        + '<p class="meta">Six characters, from a friend&rsquo;s launcher.</p>', true);
      return;
    }

    button.disabled = true;
    button.textContent = 'Looking...';

    fetch(API + '/api/profiles/' + encodeURIComponent(code))
      .then(function (res) {
        if (res.status === 404) throw new Error('No profile has that code.');
        if (!res.ok) throw new Error('Could not reach the Astra server.');
        return res.json();
      })
      .then(function (data) {
        var payload = data.payload || {};
        var mods = payload.mods || [];
        var loader = payload.loader && payload.loader !== 'vanilla'
          ? payload.loader.charAt(0).toUpperCase() + payload.loader.slice(1)
          : 'Vanilla';

        var html = '<h4>' + escape(data.name) + '</h4>'
          + '<p class="meta">' + escape(loader) + ' &middot; Minecraft '
          + escape(payload.mcVersion || '?') + ' &middot; '
          + mods.length + ' mod' + (mods.length === 1 ? '' : 's')
          + ' &middot; used ' + escape(data.uses) + ' time'
          + (data.uses === 1 ? '' : 's') + '</p>';

        if (mods.length) {
          html += '<ul>' + mods.slice(0, 40).map(function (m) {
            return '<li>' + escape(String(m).replace(/\.jar(\.disabled)?$/, '')) + '</li>';
          }).join('') + '</ul>';
        }
        html += '<p class="meta" style="margin-top:14px">'
          + 'Paste this code into Astra &rarr; Friends &rarr; Import to get the same setup.</p>';
        show(html, false);
      })
      .catch(function (err) {
        show('<h4>' + escape(err.message) + '</h4>'
          + '<p class="meta">Codes are looked up on the Astra server, so it has to be '
          + 'reachable from here.</p>', true);
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = 'Look it up';
      });
  }

  if (button) button.addEventListener('click', lookup);
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') lookup();
    });
    // Read a code straight out of the URL, so links like /?code=8W35SC work.
    var fromUrl = new URLSearchParams(location.search).get('code');
    if (fromUrl) {
      input.value = fromUrl.toUpperCase();
      lookup();
    }
  }

  // ---------------------------------------------------------------- downloads

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (release) {
      if (!release || !release.assets) return;

      var setup = release.assets.find(function (a) { return /Setup.*\.exe$/i.test(a.name); });
      var zip = release.assets.find(function (a) { return /\.zip$/i.test(a.name); });

      function point(id, asset, label) {
        var el = document.getElementById(id);
        if (!el || !asset) return;
        el.href = asset.browser_download_url;
        var span = el.querySelector('span');
        if (span) {
          span.textContent = label + ' · '
            + (asset.size / 1048576).toFixed(0) + ' MB';
        }
      }
      point('dl-setup', setup, 'Windows');
      point('dl-zip', zip, 'Zip');
    })
    .catch(function () {
      // No release yet, or GitHub is rate limiting. The buttons already point at the
      // releases page, which is a reasonable place to land either way.
    });

  // ---------------------------------------------------------------- live count

  fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.versions) return;
      var el = document.getElementById('stat-versions');
      if (el) el.textContent = data.versions.length;
    })
    .catch(function () { /* the static 900+ is fine */ });
})();
