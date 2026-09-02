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

/* Optional sources shouldn't be able to hang or kill the run. */
async function tryGet(url, label, ms = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: ac.signal });
    const body = await res.text();
    console.log(`  fetch ${label}: HTTP ${res.status}, ${body.length} bytes`);
    return res.ok ? body : null;
  } catch (e) {
    console.log(`  fetch ${label} failed: ${e.name === "AbortError" ? "timed out" : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Pulls a date and time out of a Platinumlist page, trying the most reliable
   form first: structured data, then the printed date, then the short header. */
const MONTH_NAMES = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
function readEventDate(html) {
  const ld = html.match(/"startDate"\s*:\s*"(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (ld) {
    return { y: +ld[1], mo: +ld[2] - 1, d: +ld[3], time: ld[4] ? `${ld[4]}:${ld[5]}` : "" };
  }
  const printed = html.match(new RegExp(`Date:\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})[a-z]*,?\\s*(\\d{4})`, "i"));
  const clock = html.match(/Doors\s*:?\s*(\d{1,2}:\d{2})/i);
  if (printed) {
    return { y: +printed[3], mo: MONTHS[printed[2].slice(0,3)], d: +printed[1], time: clock ? clock[1] : "" };
  }
  const short = html.match(new RegExp(`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+(\\d{1,2})\\s+(${MONTH_NAMES})`, "i"));
  if (short) {
    return { y: new Date().getUTCFullYear(), mo: MONTHS[short[2].slice(0,3)], d: +short[1], time: clock ? clock[1] : "" };
  }
  return null;
}

/* ---------- fixtures + tickets, from the league's own page ----------
   Three passes over one page, because no single part of it is complete:

   1. A <select> in the contact form lists EVERY match of the current round.
      That is the authoritative fixture list — the carousel is not.
   2. The fixture carousel carries dates, kick-off times and, for some
      matches, a direct Platinumlist link. It also mixes in U23 games, so it
      is used only to decorate matches from pass 1.
   3. Anything still without a direct link falls back to the league's own
      ticket listing, so every match is at least buyable.                    */
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const TICKETS_FALLBACK = "https://dubai.platinumlist.net/uae-pro-league";
const PLATINUMLIST_LIST = "https://uaeproleague.platinumlist.net/";

function pairKey(a, b) { return a + "|" + b; }

async function getFixtures() {
  const html = await get(LEAGUE_HOME, "league home page");

  /* --- pass 1: the definitive list of this round's matches --- */
  const round = [];
  for (const m of html.matchAll(/<option[^>]*>([^<]*?\sVS\s[^<]*?)<\/option>/gi)) {
    const tie = clean(m[1]).match(/^(.+?)\s+VS\s+(.+)$/i);
    if (!tie) continue;
    const homeKey = keyFor(tie[1]), awayKey = keyFor(tie[2]);
    if (!homeKey || !awayKey || homeKey === awayKey) continue;
    if (round.some((r) => r.homeKey === homeKey && r.awayKey === awayKey)) continue;
    round.push({ homeKey, awayKey });
  }
  console.log(`  ${round.length} matches listed for this round`);

  /* --- pass 2: dates, times and ticket links from the carousel --- */
  const extras = new Map();
  const cardRe = /<a[^>]+href="[^"]*\/en\/fixtures\/[0-9a-f][0-9a-f-]{7,}"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
  for (const card of html.matchAll(cardRe)) {
    const tie = clean(card[1]).match(/(.+?)\s+VS\s+(.+)/i);
    if (!tie) continue;
    const homeKey = keyFor(tie[1]), awayKey = keyFor(tie[2]);
    if (!homeKey || !awayKey) continue;

    const after = html.slice(card.index, card.index + 3000);
    const when = after.match(/(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{1,2}:\d{2})/);
    const link = after.match(/https:\/\/[a-z-]+\.platinumlist\.net\/(?:[a-z]{3}\/)?event-tickets\/\d+\/[a-z0-9-]+[^"'\s<>]*/i);

    const key = pairKey(homeKey, awayKey);
    const prev = extras.get(key) || {};
    extras.set(key, {
      when: prev.when || when,
      url: prev.url || (link ? link[0].split("?")[0] : null)
    });
  }

  /* Ticket links elsewhere on the page still count — match them by slug. */
  const looseRe = /https:\/\/[a-z-]+\.platinumlist\.net\/(?:[a-z]{3}\/)?event-tickets\/(\d+)\/([a-z0-9-]+)[^"'\s<>]*/gi;
  for (const m of html.matchAll(looseRe)) {
    const parts = m[2].split("-vs-");
    if (parts.length !== 2) continue;
    const homeKey = keyFor(parts[0].replace(/-/g, " "));
    const awayKey = keyFor(parts[1].replace(/-/g, " "));
    if (!homeKey || !awayKey) continue;
    const key = pairKey(homeKey, awayKey);
    const prev = extras.get(key) || {};
    if (!prev.url) extras.set(key, { ...prev, url: m[0].split("?")[0] });
  }

  /* --- pass 2.5: Platinumlist's own league listing ---
     Carries every match on sale with its date and venue. It refused a
     connection once from GitHub's network, so it's optional: if it answers
     we get complete data, if not we carry on with what the league page gave. */
  const listing = await tryGet(PLATINUMLIST_LIST, "platinumlist listing");
  if (listing) {
    /* Each event's details sit between its own link and the next one. Slicing
       on that boundary stops one match borrowing its neighbour's date. */
    const hits = [...listing.matchAll(looseRe)];
    let added = 0;
    for (let i = 0; i < hits.length; i++) {
      const m = hits[i];
      const parts = m[2].split("-vs-");
      if (parts.length !== 2) continue;
      const homeKey = keyFor(parts[0].replace(/-/g, " "));
      const awayKey = keyFor(parts[1].replace(/-/g, " "));
      if (!homeKey || !awayKey) continue;

      const blockEnd = i + 1 < hits.length ? hits[i + 1].index : listing.length;
      const block = listing.slice(m.index, Math.min(blockEnd, m.index + 3000));

      const key = pairKey(homeKey, awayKey);
      const prev = extras.get(key) || {};
      const stamp = readEventDate(block);
      const venue = block.match(/Venue:\s*([^<\n|·]{3,70})/i);
      if (!prev.url || (!prev.when && stamp)) added++;
      extras.set(key, {
        when: prev.when,
        stamp: prev.stamp || stamp,
        venue: prev.venue || (venue ? clean(venue[1]).replace(/\s*[-–·].*$/, "") : ""),
        url: prev.url || m[0].split("?")[0]
      });
    }
    console.log(`  listing filled in details for ${added} matches`);
  }

  /* --- pass 4: last resort, open the individual ticket pages ---
     Only for matches still missing a date, and capped so a bad day costs
     seconds rather than minutes. */
  const dateless = round.filter(({ homeKey, awayKey }) => {
    const e = extras.get(pairKey(homeKey, awayKey));
    return e && e.url && !e.when && !e.stamp;
  }).slice(0, 6);

  for (const { homeKey, awayKey } of dateless) {
    const key = pairKey(homeKey, awayKey);
    const e = extras.get(key);
    const page = await tryGet(e.url, `event page ${homeKey} v ${awayKey}`);
    if (!page) continue;
    const stamp = readEventDate(page);
    const venue = page.match(/Venue:\s*([^<\n|·]{3,70})/i);
    if (stamp) extras.set(key, { ...e, stamp, venue: e.venue || (venue ? clean(venue[1]) : "") });
  }

  /* --- pass 3: assemble --- */
  let direct = 0;
  const out = round.map(({ homeKey, awayKey }) => {
    const e = extras.get(pairKey(homeKey, awayKey)) || {};
    let date = "", time = "", sortKey = Number.MAX_SAFE_INTEGER;

    /* The league carousel gives "04 Sep 17:45"; Platinumlist gives a full
       timestamp. Prefer the carousel, since it always carries a kick-off. */
    let y, mo, d, hh = 0, mm = 0;
    if (e.when && MONTHS[e.when[2]] !== undefined) {
      y = new Date().getUTCFullYear(); mo = MONTHS[e.when[2]]; d = +e.when[1];
      [hh, mm] = e.when[3].split(":").map(Number);
      time = e.when[3];
    } else if (e.stamp) {
      ({ y, mo, d } = e.stamp);
      if (e.stamp.time) { [hh, mm] = e.stamp.time.split(":").map(Number); time = e.stamp.time; }
    }
    if (y !== undefined) {
      const dt = new Date(Date.UTC(y, mo, d, hh, mm));
      sortKey = dt.getTime();
      date = dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    }
    if (e.url) direct++;
    return {
      date, time, sortKey,
      home: DISPLAY[homeKey] || homeKey,
      away: DISPLAY[awayKey] || awayKey,
      venueKey: homeKey,
      venue: e.venue || "",
      url: e.url || TICKETS_FALLBACK,
      directLink: Boolean(e.url)
    };
  });

  const dated = out.filter((f) => f.date).length;
  console.log(`  ${direct} of ${out.length} have a direct ticket link, ${dated} of ${out.length} have a date`);
  if (!out.length) {
    const hint = html.match(/platinumlist\.net[^"'\s]{0,60}/i);
    console.error("  no fixtures found on the page. Nearest ticket link: " + (hint ? hint[0] : "none"));
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
