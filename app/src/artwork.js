'use strict';

/**
 * Official Minecraft artwork per version.
 *
 * Mojang's own launcher pulls its patch-note art from launchercontent.mojang.com, so
 * that is where these come from - real key art for each release and snapshot rather
 * than something scraped or invented.
 *
 * The feed does not reach the very newest versions, so `imageFor` falls back to the
 * closest relative: the newest entry sharing a major.minor line, then the newest entry
 * of the same type. Every version ends up with a picture, and the picture is always
 * something Mojang actually published for that era of the game.
 */

const { getJson } = require('./net');

// v2 is the current feed: 406 entries, and it actually reaches modern versions.
// The old top-level path still answers 200 but stops at January 2024, which made
// every version after 1.20.4 fall back to the same picture. v1 stays as a fallback
// only in case v2 ever goes away.
const PATCH_NOTES = 'https://launchercontent.mojang.com/v2/javaPatchNotes.json';
const PATCH_NOTES_V1 = 'https://launchercontent.mojang.com/javaPatchNotes.json';
const NEWS = 'https://launchercontent.mojang.com/v2/news.json';
const CDN = 'https://launchercontent.mojang.com';

let cache = null;
let newsCache = null;

function absolute(url) {
  if (!url) return null;
  return url.startsWith('http') ? url : `${CDN}${url}`;
}

/** version id -> {image, title, type, body} for everything the feed knows about. */
async function index() {
  if (cache) return cache;

  let data;
  try {
    data = await getJson(PATCH_NOTES);
  } catch (_) {
    data = await getJson(PATCH_NOTES_V1);
  }
  const byVersion = new Map();
  const order = [];

  for (const entry of data.entries || []) {
    if (!entry.version) continue;
    const record = {
      version: entry.version,
      title: entry.title || entry.version,
      type: entry.type || 'release',
      image: absolute(entry.image && entry.image.url)
    };
    if (!byVersion.has(entry.version)) {
      byVersion.set(entry.version, record);
      order.push(record);
    }
  }

  // The feed is newest first; keep that so "closest relative" means "most recent".
  cache = { byVersion, order };
  return cache;
}

/** 1.21.11 -> "1.21", 26.2 -> "26", 24w03b -> null (snapshots have no line). */
function familyOf(versionId) {
  const match = /^(\d+)\.(\d+)/.exec(versionId);
  if (match) return `${match[1]}.${match[2]}`;
  const single = /^(\d+)$/.exec(versionId);
  return single ? single[1] : null;
}

function isSnapshotId(versionId) {
  return /w\d{2}[a-z]/i.test(versionId) || /-(pre|rc)/i.test(versionId);
}

/** [major, minor, patch] for anything numeric, else null. */
function numericParts(versionId) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(versionId);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function distance(a, b) {
  return Math.abs(a[0] - b[0]) * 10000
    + Math.abs(a[1] - b[1]) * 100
    + Math.abs(a[2] - b[2]);
}

async function imageFor(versionId) {
  const { byVersion, order } = await index();

  const exact = byVersion.get(versionId);
  if (exact && exact.image) return { url: exact.image, exact: true, from: versionId };

  const family = familyOf(versionId);
  if (family) {
    const relative = order.find((entry) => entry.image && familyOf(entry.version) === family);
    if (relative) return { url: relative.image, exact: false, from: relative.version };
  }

  // Minecraft dropped the leading "1." in 2026, so anything with a major above 1 is
  // newer than everything this feed knows about. Distance maths would put 26.2 next
  // to 1.13 purely because 2 is closer to 13 than to 20, which is nonsense - it is
  // the newest version, so it gets the newest art.
  const parts = numericParts(versionId);
  if (parts && parts[0] > 1) {
    const newest = order.find((entry) => entry.image && entry.type === 'release')
      || order.find((entry) => entry.image);
    if (newest) return { url: newest.image, exact: false, from: newest.version };
  }

  // Otherwise the nearest numeric neighbour. Without this every unmatched version
  // lands on the same picture, which makes the gallery look broken rather than
  // merely approximate - 1.8.9 should not wear 1.20's key art.
  if (parts) {
    let best = null;
    let bestDistance = Infinity;
    for (const entry of order) {
      if (!entry.image) continue;
      const candidate = numericParts(entry.version);
      if (!candidate) continue;
      const d = distance(parts, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = entry;
      }
    }
    if (best) return { url: best.image, exact: false, from: best.version };
  }

  const snapshot = isSnapshotId(versionId);
  const sameType = order.find((entry) => entry.image
    && (entry.type === 'snapshot') === snapshot);
  if (sameType) return { url: sameType.image, exact: false, from: sameType.version };

  const any = order.find((entry) => entry.image);
  return any ? { url: any.image, exact: false, from: any.version } : null;
}

/** Resolves a batch in one pass, which is what the version list actually needs. */
async function imagesFor(versionIds) {
  await index();
  const out = {};
  for (const id of versionIds) {
    try {
      out[id] = await imageFor(id);
    } catch (_) {
      out[id] = null;
    }
  }
  return out;
}

async function news(limit = 8) {
  if (!newsCache) {
    const data = await getJson(NEWS);
    newsCache = (data.entries || []).map((entry) => ({
      title: entry.title,
      category: entry.category,
      date: entry.date,
      text: entry.text,
      link: entry.readMoreLink,
      image: absolute(entry.newsPageImage && entry.newsPageImage.url)
    }));
  }
  return newsCache.slice(0, limit);
}

module.exports = { index, imageFor, imagesFor, news };
