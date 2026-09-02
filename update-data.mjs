/**
 * ADNOC Pro League — data refresher
 * ---------------------------------------------------------------
 * Fetches the current standings and whatever tickets are on sale,
 * then writes data.json next to pick-a-club.html.
 *
 * Runs in GitHub Actions on a schedule (see update-data.yml), so
 * scraping happens on a server where CORS doesn't apply and the
 * published page only ever loads a same-origin JSON file.
 *
 *   node update-data.mjs            # writes ./data.json
 *   node update-data.mjs --dry-run  # prints, writes nothing
 *
 * Exits non-zero if either parser comes back empty, which fails the
 * workflow and emails you — that's the breakage alarm.
 */

import { writeFile } from "node:fs/promises";

const STANDINGS_URL =
  "https://www.worldfootball.net/competition/co1183/ua-emirates-uae-pro-league/results-and-standings/";
const TICKETS_URL = "https://uaeproleague.platinumlist.net/";
const UA = "Mozilla/5.0 (compatible; pick-a-club/1.0; +https://github.com)";

const CLUB_KEYS = {
  "united": "United", "dubai united": "United",
  "al wasl": "Al Wasl", "wasl": "Al Wasl",
  "al nasr": "Al Nasr", "nasr": "Al Nasr",
  "shabab al ahli": "Shabab Al Ahli", "al ahli": "Shabab Al Ahli",
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

const clean = (s) =>
  (s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function keyFor(name) {
  const n = clean(name).toLowerCase().replace(/\s*(fc|sc|club)\b/g, "").trim();
  if (CLUB_KEYS[n]) return CLUB_KEYS[n];
  // Longest alias first, so "ittihad kalba" wins over "kalba".
  const aliases = Object.keys(CLUB_KEYS).sort((a, b) => b.length - a.length);
  for (const alias of aliases) if (n.includes(alias)) return CLUB_KEYS[alias];
  return null;
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

/* ---------- standings ----------
   Deliberately structure-agnostic. Earlier versions keyed off the shape of
   the team links, which broke the moment the source changed its markup.
   This walks every table on the page, treats any row containing a club we
   recognise as a candidate, and keeps only rows where wins + draws + losses
   equals games played. That arithmetic check is what makes it safe to be
   loose about everything else. */
async function getStandings() {
  const html = await get(STANDINGS_URL);
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = [], inspected = 0;

  for (const table of tables) {
    const rows = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(clean);
      if (cells.length < 6) continue;
      inspected++;

      const nameIdx = cells.findIndex((c) => c.length > 2 && keyFor(c));
      if (nameIdx === -1) continue;
      const key = keyFor(cells[nameIdx]);
      if (rows.some((r) => r.key === key)) continue;   // first row per club wins

      // Read the numbers that follow the club name.
      const nums = [];
      let gf = null, ga = null;
      for (const c of cells.slice(nameIdx + 1)) {
        const combined = c.match(/^(\d+)\s*[:\-]\s*(\d+)$/);   // "8:1" style
        if (combined && gf === null) { gf = +combined[1]; ga = +combined[2]; continue; }
        const n = c.match(/^([+\-\u2212]?\d+)$/);
        if (n) nums.push(Number(n[1].replace('\u2212', '-')));
      }
      if (nums.length < 5) continue;

      const [p, w, d, l] = nums;
      const pts = nums[nums.length - 1];
      if (gf === null) { gf = nums[4]; ga = nums[5]; }        // separate GF / GA columns
      if (![p, w, d, l, pts, gf, ga].every(Number.isFinite)) continue;
      if (w + d + l !== p) continue;                          // the real validity test
      if (pts > p * 3) continue;

      rows.push({ key, name: clean(cells[nameIdx]), p, w, d, l, gf, ga, pts });
    }
    if (rows.length > best.length) best = rows;
  }

  console.log(`  scanned ${tables.length} tables, ${inspected} candidate rows`);

  if (best.length < 10) {
    // Print enough to diagnose without dumping the whole page into the log.
    const sample = (html.match(/<tr[\s\S]*?<\/tr>/gi) || []).slice(0, 4)
      .map((tr) => (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(clean).join(' | '))
      .filter(Boolean);
    if (sample.length) {
      console.error('  first rows seen on the page, for debugging:');
      sample.forEach((s) => console.error('    ' + s.slice(0, 160)));
    }
  }

  best.sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  return best;
}

/* ---------- fixtures on sale ---------- */
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

async function getFixtures() {
  const html = await get(TICKETS_URL);
  const seen = new Set();
  const out = [];

  const linkRe =
    /https:\/\/[a-z-]+\.platinumlist\.net\/aed\/event-tickets\/(\d+)\/([a-z0-9-]+)\/ticket-office/gi;

  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const [url, id, slug] = [m[0], m[1], m[2]];
    if (seen.has(id)) continue;
    seen.add(id);

    const parts = slug.split("-vs-");
    if (parts.length !== 2) continue;

    const title = (s) =>
      s.replace(/-/g, " ").replace(/\bfc\b/gi, "").replace(/\s+/g, " ").trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());

    const home = title(parts[0]);
    const away = title(parts[1]);
    const homeKey = keyFor(home);
    if (!homeKey) continue;

    const near = html.slice(Math.max(0, m.index - 3000), m.index + 3000);
    const dateM = near.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Z][a-z]{2}),?\s+(\d{4})/);
    const venueM =
      near.match(/\*\*Venue:\*\*\s*([^\n*]+)/) || near.match(/Venue:\s*([^\n<]+)/);

    let date = "", sortKey = Number.MAX_SAFE_INTEGER;
    if (dateM && MONTHS[dateM[2]] !== undefined) {
      const d = new Date(Date.UTC(+dateM[3], MONTHS[dateM[2]], +dateM[1]));
      sortKey = d.getTime();
      date = d.toLocaleDateString("en-GB", {
        weekday: "short", day: "numeric", month: "short", timeZone: "UTC"
      });
    }

    out.push({
      date, sortKey, home, away,
      venueKey: homeKey,
      venue: venueM ? clean(venueM[1]) : "",
      url
    });
  }

  out.sort((a, b) => a.sortKey - b.sortKey);
  return out.map(({ sortKey, ...f }) => f);
}

/* ---------- run ---------- */
const dryRun = process.argv.includes("--dry-run");

const [standings, fixtures] = await Promise.all([
  getStandings().catch((e) => { console.error("standings:", e.message); return []; }),
  getFixtures().catch((e) => { console.error("fixtures:", e.message); return []; })
]);

const played = standings.length ? standings[0].p : null;
const payload = {
  fetchedAt: new Date().toISOString(),
  standings: standings.length >= 10 ? standings : [],
  standingsLabel: played ? `after matchweek ${played}` : "updated just now",
  fixtures
};

console.log(`standings: ${standings.length} clubs`);
console.log(`fixtures:  ${fixtures.length} matches on sale`);

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  await writeFile("data.json", JSON.stringify(payload, null, 2) + "\n");
  console.log("wrote data.json");
}

/* Empty standings means the parser broke. We still write data.json — the page
   ignores an empty standings array and falls back to its snapshot, and fixtures
   may well have parsed fine. The workflow commits first and checks afterwards,
   so a standings break never blocks a ticket refresh. */
if (standings.length < 10) {
  console.error("::error::Standings parser returned " + standings.length +
    " rows. The source markup has probably changed.");
  await writeFile("parser-status.txt", "standings-failed\n");
} else {
  await writeFile("parser-status.txt", "ok\n");
}
if (!fixtures.length) {
  console.warn("::warning::No fixtures on sale — normal between rounds, but worth a look if it persists.");
}
