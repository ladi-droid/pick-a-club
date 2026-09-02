/**
 * ADNOC Pro League — data refresher
 * ---------------------------------------------------------------
 * Writes data.json next to index.html. Run by GitHub Actions on a
 * schedule; see update-data.yml.
 *
 *   node update-data.mjs            # writes ./data.json
 *   node update-data.mjs --dry-run  # prints, writes nothing
 *
 * SOURCES, AND WHY THESE ONES
 *
 * Fixtures + tickets: the league's own home page. It is rendered on the
 * server, carries kick-off times, and links straight out to each match's
 * Platinumlist page. Scraping Platinumlist directly does not work from a
 * data centre — the connection never completes.
 *
 * Standings: harder. The league renders its table in the browser, so the
 * HTML arrives empty. worldfootball.net sits behind Cloudflare and serves a
 * challenge page to anything that isn't a real browser. Wikipedia has no
 * article for this season yet. So standings are OPTIONAL here:
 *   - Set an API_FOOTBALL_KEY secret and they come from api-football.
 *   - Leave it unset and data.json ships without them; the page falls back
 *     to its built-in table and says so. Fixtures still refresh either way.
 */

import { writeFile } from "node:fs/promises";

const LEAGUE_HOME = "https://www.uaeproleague.ae/en";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const API_FOOTBALL = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || "";
const API_LEAGUE_ID = process.env.API_FOOTBALL_LEAGUE_ID || "301";
const API_SEASON = process.env.API_FOOTBALL_SEASON || "2026";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9"
};

const CLUB_KEYS = {
  "united": "United", "dubai united": "United",
  "al wasl": "Al Wasl", "wasl": "Al Wasl",
  "al nasr": "Al Nasr", "nasr": "Al Nasr",
  "shabab al ahli": "Shabab Al Ahli", "shabab alahli": "Shabab Al Ahli", "al ahli": "Shabab Al Ahli",
  "sharjah": "Sharjah",
  "ajman": "Ajman",
  "baniyas": "Baniyas", "bani yas": "Baniyas",
  "al ain": "Al Ain",
  "al jazira": "Al Jazira", "jazira": "Al Jazira",
  "al wahda": "Al Wahda", "wahda": "Al Wahda",
  "hatta": "Hatta",
  "ittihad kalba": "Kalba", "kalba": "Kalba",
  "khor fakkan": "Khor Fakkan", "khorfakkan": "Khor Fakkan",
  "al dhafra": "Al Dhafra", "dhafra": "Al Dhafra"
};

const DISPLAY = {
  "United": "United FC", "Al Wasl": "Al Wasl", "Al Nasr": "Al Nasr",
  "Shabab Al Ahli": "Shabab Al Ahli", "Sharjah": "Sharjah", "Ajman": "Ajman",
  "Baniyas": "Baniyas", "Al Ain": "Al Ain", "Al Jazira": "Al Jazira",
  "Al Wahda": "Al Wahda", "Hatta": "Hatta", "Kalba": "Ittihad Kalba",
  "Khor Fakkan": "Khor Fakkan", "Al Dhafra": "Al Dhafra"
};

const clean = (s) =>
  (s || "").replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();

function keyFor(name) {
  const n = clean(name).toLowerCase().replace(/\s*(fc|sc|club)\b/g, "").trim();
  if (CLUB_KEYS[n]) return CLUB_KEYS[n];
  const aliases = Object.keys(CLUB_KEYS).sort((a, b) => b.length - a.length);
  for (const alias of aliases) if (n.includes(alias)) return CLUB_KEYS[alias];
  return null;
}

async function get(url, label = url, headers = BROWSER_HEADERS) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const body = await res.text();
  console.log(`  fetch ${label}: HTTP ${res.status}, ${body.length} bytes`);
  if (!res.ok) {
    console.error(`  first 300 chars: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    throw new Error(`${label} responded ${res.status}`);
  }
  return body;
}

/* ---------- fixtures + tickets, from the league's own page ---------- */
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

async function getFixtures() {
  const html = await get(LEAGUE_HOME, "league home page");
  const seen = new Set();
  const out = [];

  // Ticket links come in a few shapes — with or without /aed/, with or
  // without /ticket-office, often trailed by analytics parameters.
  const linkRe = /https:\/\/[a-z-]+\.platinumlist\.net\/(?:[a-z]{3}\/)?event-tickets\/(\d+)\/([a-z0-9-]+)[^"'\s<>]*/gi;

  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const [rawUrl, id, slug] = [m[0], m[1], m[2]];
    if (seen.has(id)) continue;

    const parts = slug.split("-vs-");
    if (parts.length !== 2) continue;

    const homeKey = keyFor(parts[0].replace(/-/g, " "));
    const awayKey = keyFor(parts[1].replace(/-/g, " "));
    if (!homeKey || !awayKey) {
      console.log(`  skipped "${slug}" — club names not recognised`);
      continue;
    }
    seen.add(id);

    const url = rawUrl.split("?")[0];   // drop the tracking tail

    // Kick-off sits just above the button, e.g. "04 Sep 17:45".
    const before = html.slice(Math.max(0, m.index - 2000), m.index);
    const when = [...before.matchAll(/(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{1,2}:\d{2})/g)].pop();

    let date = "", time = "", sortKey = Number.MAX_SAFE_INTEGER;
    if (when && MONTHS[when[2]] !== undefined) {
      const d = new Date(Date.UTC(new Date().getUTCFullYear(), MONTHS[when[2]], +when[1]));
      sortKey = d.getTime();
      date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      time = when[3];
    }

    out.push({
      date, time, sortKey,
      home: DISPLAY[homeKey] || homeKey,
      away: DISPLAY[awayKey] || awayKey,
      venueKey: homeKey,
      venue: "",                 // the page supplies this from its own club data
      url
    });
  }

  console.log(`  ${seen.size} ticket links found, ${out.length} usable fixtures`);
  if (!seen.size) {
    const hint = html.match(/platinumlist\.net[^"'\s]{0,60}/i);
    console.error("  no ticket links on the page. Nearest match: " + (hint ? hint[0] : "none"));
  }

  out.sort((a, b) => a.sortKey - b.sortKey);
  return out.map(({ sortKey, ...f }) => f);
}

/* ---------- standings, only if a key is available ---------- */
async function getStandingsFromApi() {
  const url = `${API_FOOTBALL}/standings?league=${API_LEAGUE_ID}&season=${API_SEASON}`;
  const json = JSON.parse(await get(url, "api-football", { "x-apisports-key": API_KEY }));

  if (json.errors && Object.keys(json.errors).length) {
    console.error("  api-football returned errors: " + JSON.stringify(json.errors));
    return [];
  }
  const table = json?.response?.[0]?.league?.standings?.[0];
  if (!Array.isArray(table)) {
    console.error(`  no table for league ${API_LEAGUE_ID}, season ${API_SEASON}. ` +
                  "Check API_FOOTBALL_LEAGUE_ID and API_FOOTBALL_SEASON.");
    return [];
  }

  const rows = [];
  for (const r of table) {
    const key = keyFor(r?.team?.name || "");
    if (!key) { console.log(`  unmatched club name from API: "${r?.team?.name}"`); continue; }
    const a = r.all || {};
    rows.push({
      key,
      name: DISPLAY[key] || clean(r.team.name),
      p: a.played ?? 0, w: a.win ?? 0, d: a.draw ?? 0, l: a.lose ?? 0,
      gf: a.goals?.for ?? 0, ga: a.goals?.against ?? 0,
      pts: r.points ?? 0
    });
  }
  console.log(`  api-football gave ${rows.length} rows`);
  return rows;
}

/* No article exists for this season yet, but one eventually will. Searching
   rather than guessing titles means this starts working on its own. */
async function getStandingsFromWikipedia() {
  try {
    const found = JSON.parse(await get(
      `${WIKI_API}?action=query&list=search&format=json&srlimit=1&srsearch=`
      + encodeURIComponent("2026-27 UAE Pro League"), "wikipedia search"));
    const title = found?.query?.search?.[0]?.title;
    if (!title || !/UAE Pro League/i.test(title) || !/2026/.test(title)) {
      console.log(`  no article for this season yet${title ? ` (best match: "${title}")` : ""}`);
      return [];
    }
    const page = JSON.parse(await get(
      `${WIKI_API}?action=parse&prop=text&format=json&page=${encodeURIComponent(title)}`,
      `wikipedia "${title}"`));
    const rows = page?.parse?.text?.["*"] ? parseStandingsHtml(page.parse.text["*"]) : [];
    console.log(`  wikipedia gave ${rows.length} usable rows`);
    return rows;
  } catch (e) {
    console.log(`  wikipedia failed: ${e.message}`);
    return [];
  }
}

/* Structure-agnostic table reader: any row holding a club we recognise, kept
   only if wins + draws + losses equals games played. That check is what makes
   it safe to be loose about everything else. */
function parseStandingsHtml(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = [];
  for (const table of tables) {
    const rows = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(clean);
      if (cells.length < 6) continue;
      const nameIdx = cells.findIndex((c) => c.length > 2 && keyFor(c));
      if (nameIdx === -1) continue;
      const key = keyFor(cells[nameIdx]);
      if (rows.some((r) => r.key === key)) continue;

      const nums = [];
      let gf = null, ga = null;
      for (const c of cells.slice(nameIdx + 1)) {
        const combined = c.match(/^(\d+)\s*[:\-]\s*(\d+)$/);
        if (combined && gf === null) { gf = +combined[1]; ga = +combined[2]; continue; }
        const n = c.match(/^([+\-\u2212]?\d+)$/);
        if (n) nums.push(Number(n[1].replace("\u2212", "-")));
      }
      if (nums.length < 5) continue;
      const [p, w, d, l] = nums;
      const pts = nums[nums.length - 1];
      if (gf === null) { gf = nums[4]; ga = nums[5]; }
      if (![p, w, d, l, pts, gf, ga].every(Number.isFinite)) continue;
      if (w + d + l !== p || pts > p * 3) continue;
      rows.push({ key, name: DISPLAY[key] || clean(cells[nameIdx]), p, w, d, l, gf, ga, pts });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

async function getStandings() {
  let rows = [];
  if (API_KEY) {
    try { rows = await getStandingsFromApi(); }
    catch (e) { console.log(`  api-football failed: ${e.message}`); }
  } else {
    console.log("  no API_FOOTBALL_KEY set — skipping the standings API");
  }
  if (rows.length < 10) rows = await getStandingsFromWikipedia();
  rows.sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  return rows;
}

/* ---------- run ---------- */
const dryRun = process.argv.includes("--dry-run");

console.log("Fixtures:");
const fixtures = await getFixtures().catch((e) => { console.error("  " + e.message); return []; });
console.log("Standings:");
const standings = await getStandings().catch((e) => { console.error("  " + e.message); return []; });

const played = standings.length ? standings[0].p : null;
const payload = {
  fetchedAt: new Date().toISOString(),
  standings: standings.length >= 10 ? standings : [],
  standingsLabel: played ? `after matchweek ${played}` : "updated just now",
  fixtures
};

console.log(`\nResult: ${standings.length} clubs, ${fixtures.length} matches on sale`);

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  await writeFile("data.json", JSON.stringify(payload, null, 2) + "\n");
  console.log("wrote data.json");
}

/* Fixtures must work — they change weekly and have no fallback. Standings are
   optional by design, so their absence is a note rather than a failure. */
const ok = fixtures.length > 0;
await writeFile("parser-status.txt", ok ? "ok\n" : "fixtures-failed\n");

if (!ok) {
  console.error("::error::No fixtures found. The league page layout has probably changed.");
}
if (standings.length < 10) {
  console.warn("::warning::Standings unavailable — the page shows its built-in table. " +
               "Add an API_FOOTBALL_KEY secret for live standings.");
}
