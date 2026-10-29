// Turns schools' MealViewer menus into iCalendar feeds that Skylight, Google Calendar,
// Apple Calendar etc. can subscribe to. Settings come from the [vars] in wrangler.toml:
// each [vars.FEEDS.<name>] table becomes a feed at /<name>.ics, or without FEEDS the
// top-level settings make a single /lunch.ics feed.

const DAYS_BACK = 7;
const DAYS_AHEAD = 35;
const CACHE_SECONDS = 3600;
const FETCH_TIMEOUT_MS = 10_000;

// The four groups we show, in title/description order, each with its display label.
const KEEP_TYPES = { ENTREES: "Entrées", VEGETABLE: "Veggies", GRAINS: "Sides", FRUIT: "Fruit" };
// MealViewer's item_Type naming varies by district: some use "ENTREES"/"Breads/Grains",
// others "Entree"/"Meatless Entree"/"Grain". Map each to one of the groups above, or null to skip
// (milk, dessert, condiments). Matching is loose so a new district's wording still lands in a group.
function classifyType(type) {
  const t = cleanText(type).toLowerCase();
  if (!t) return null;
  if (t.includes("entree") || t.includes("entrée")) return "ENTREES";
  if (t.includes("vegetable") || t.includes("veggie")) return "VEGETABLE";
  if (t.includes("fruit")) return "FRUIT";
  if (t.includes("grain") || t.includes("bread")) return "GRAINS";
  return null;
}
const CONDIMENTS = new Set([
  "ketchup", "mustard", "ranch", "mayo", "mayonnaise", "margarine", "butter",
  "syrup", "salsa", "cream cheese", "sour cream", "jelly", "honey",
]);
// Standalone sauces/garnishes ("Sweet Chili Sauce"), but not dishes served with one
// ("Nachos with Cheese Sauce", "Biscuits and Gravy", "Chips & Dip").
const CONDIMENT_SUFFIX = /\b(sauce|dressing|dip|gravy)$/i;
const SERVED_WITH = /\bw\/|\bwith\b|\band\b|&/i;
const GARNISH = /\bgarnish$/i;
// Section headers, for menus typed entirely in capitals where case alone can't tell them apart.
const HEADER_NAME = /^(featured |daily )?(entrees?|vegetables?|fruits?|sides?|grains?|milk|options?|selections?|choice of \w+)$/i;
// Everyday staples (sunbutter & jelly sandwiches, bread rolls) stay in the notes but don't crowd
// the event title. "Egg Roll" and "Spring Roll" are mains, so only bread-type rolls match.
const TITLE_SKIP = /^(SBJ|WBJ|PBJ) Sandwich$|\b(dinner|bread|wheat|whole grain|wg|hawaiian) roll$/i;
// Preschool / 3-5 year old serving lines, kept out of the feed (see cafeteriaLineList loop).
const SKIP_LINE = /\b\d\s*-\s*\d year old\b|\bpre-?k\b|\bpre-?school\b/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const feedPath = url.pathname.match(/^\/([A-Za-z0-9-]+)\.ics$/);
    if (!feedPath && url.pathname !== "/menus") {
      return new Response("Not found", { status: 404 });
    }

    let feeds;
    try {
      feeds = readFeeds(env);
    } catch (err) {
      return new Response(err.message, { status: 500 });
    }

    // Lists the menu names MealViewer has for each configured school, to help pick the right MEAL setting.
    if (url.pathname === "/menus") {
      const problems = [...feeds.values()].filter((feed) => feed.error).map((feed) => `Feed "${feed.feedName}": ${feed.error}\n`);
      const schools = new Map([...feeds.values()].filter((feed) => !feed.error).map((feed) => [feed.schoolId, feed]));
      // One school's outage shouldn't hide the others, so each is reported on its own.
      const sections = await Promise.all(
        [...schools.values()].map(async (feed) => {
          try {
            const { schoolName, menuNames } = await fetchMenuNames(feed);
            const school = schoolName ? `${schoolName} (${feed.schoolId})` : feed.schoolId;
            return menuNames.length
              ? `Menus for ${school}. Set MEAL to one of these:\n\n${menuNames.join("\n")}\n`
              : `No menus found for ${school} in the next few weeks. Check SCHOOL_ID, or try again once the school posts its menu.\n`;
          } catch (err) {
            console.error("Failed to load menu names:", err);
            return `Couldn't reach MealViewer for ${feed.schoolId} right now. Try again in a few minutes.\n`;
          }
        }),
      );
      return new Response([...problems, ...sections].join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const config = feeds.get(feedPath[1].toLowerCase());
    if (!config) {
      return new Response("Not found", { status: 404 });
    }
    if (config.error) {
      return new Response(config.error, { status: 500 });
    }

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/${config.feedName}.ics`);
    // A client sending "Cache-Control: no-cache" (or "Pragma: no-cache") forces a refresh,
    // so a newly fixed feed can be re-fetched without waiting for the cached copy to expire.
    const noCache = /no-cache/i.test(`${request.headers.get("Cache-Control") ?? ""} ${request.headers.get("Pragma") ?? ""}`);
    const cached = noCache ? null : await cache.match(cacheKey);
    if (cached) return cached;

    let ics;
    try {
      const days = await fetchMenu(config);
      ics = buildCalendar(days, config);
    } catch (err) {
      console.error("Failed to load menu:", err);
      return new Response("Menu temporarily unavailable", { status: 502 });
    }

    const response = new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },

  // Cron trigger: mirror each feed's menu into the Skylight Meals planner, if configured.
  // No-op (so ICS-only deployments are unaffected) unless Skylight credentials are set.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncSkylight(env).then(
        (result) => console.log("Skylight sync:", JSON.stringify(result)),
        (err) => console.error("Skylight sync failed:", err?.stack || err),
      ),
    );
  },
};

// Returns a Map of feed name -> settings. Feeds inherit the top-level SCHOOL_ID, SCHOOL_NAME and
// TIMEZONE unless they set their own (e.g. a sibling at a different school). A feed with a bad
// setting is kept as { feedName, error } so a typo in one feed doesn't take the others down.
function readFeeds(env) {
  let defs = env.FEEDS;
  if (typeof defs === "string") {
    try {
      defs = JSON.parse(defs); // FEEDS set as a JSON variable in the Cloudflare dashboard
    } catch {
      throw new Error("FEEDS must be a table in wrangler.toml (or valid JSON).");
    }
  }
  if (Array.isArray(defs)) {
    throw new Error('FEEDS must be tables like [vars.FEEDS.lunch] with single brackets, not [[vars.FEEDS]].');
  }
  const fromFeeds = Boolean(defs && typeof defs === "object");
  const entries = fromFeeds
    ? Object.entries(defs)
    : [["lunch", { MEAL: env.MEAL, CALENDAR_NAME: env.CALENDAR_NAME, EVENT_PREFIX: env.EVENT_PREFIX }]];
  if (!entries.length) throw new Error("FEEDS is empty. Add at least one [vars.FEEDS.<name>] table.");

  const feeds = new Map();
  for (const [name, def] of entries) {
    const feedName = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(feedName)) {
      throw new Error(`Feed name "${name}" can only use letters, numbers and dashes.`);
    }
    if (feeds.has(feedName)) throw new Error(`Feed name "${name}" is used twice.`);
    try {
      if (!def || typeof def !== "object") throw new Error(`Feed "${name}" must be a table of settings.`);
      const inherited = { SCHOOL_ID: env.SCHOOL_ID, TIMEZONE: env.TIMEZONE };
      // The top-level school name only applies to feeds at the top-level school.
      if (!("SCHOOL_ID" in def)) inherited.SCHOOL_NAME = env.SCHOOL_NAME;
      // In FEEDS mode each feed names its menu; the legacy single-feed config may leave MEAL off.
      if (fromFeeds && !String(def.MEAL ?? "").trim()) {
        throw new Error(`MEAL is not set for the "${feedName}" feed. Add MEAL = "..." under [vars.FEEDS.${feedName}] (see /menus for the names).`);
      }
      feeds.set(feedName, readFeed(feedName, { ...inherited, ...def }));
    } catch (err) {
      feeds.set(feedName, { feedName, error: err.message });
    }
  }
  return feeds;
}

function readFeed(feedName, vars) {
  const schoolId = String(vars.SCHOOL_ID ?? "").trim();
  if (!/^[A-Za-z0-9-]+$/.test(schoolId) || schoolId === "YOUR-SCHOOL-ID") {
    throw new Error(`SCHOOL_ID is not set for the "${feedName}" feed. Add it under [vars] or [vars.FEEDS.${feedName}] in wrangler.toml and redeploy.`);
  }
  const timezone = String(vars.TIMEZONE || "America/New_York");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`TIMEZONE "${timezone}" is not a valid IANA time zone name.`);
  }
  const meal = String(vars.MEAL || "Lunch");
  const { word, emoji } = mealLabel(meal);
  // An optional short school name ("Lincoln") goes into the labels, so several schools' calendars
  // can be told apart on one board: "Lincoln Lunch" / "🍽 Lincoln Lunch:".
  const schoolName = String(vars.SCHOOL_NAME ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const label = schoolName ? `${schoolName} ${word}` : word;
  // Feeds push to Skylight Meals by default. SKYLIGHT = false keeps a feed's .ics calendar
  // but leaves it out of the Skylight sync (set as a bool in wrangler.toml, or "false" as a var).
  const skylight = !(vars.SKYLIGHT === false || String(vars.SKYLIGHT).toLowerCase() === "false");
  return {
    feedName,
    schoolId,
    meal,
    timezone,
    skylight,
    calendarName: String(vars.CALENDAR_NAME || (schoolName ? label : `School ${word}`)),
    eventPrefix: String(vars.EVENT_PREFIX || `${emoji} ${label}:`),
  };
}

// Default labels so a breakfast feed doesn't say "Lunch" unless told otherwise.
function mealLabel(meal) {
  if (/breakfast/i.test(meal)) return { word: "Breakfast", emoji: "🥞" };
  if (/snack/i.test(meal)) return { word: "Snack", emoji: "🍎" };
  if (/supper|dinner/i.test(meal)) return { word: "Supper", emoji: "🍲" };
  return { word: "Lunch", emoji: "🍽" };
}

async function fetchSchedules({ schoolId, timezone }) {
  const today = todayInTZ(timezone);
  const start = addDays(today, -DAYS_BACK);
  const end = addDays(today, DAYS_AHEAD);
  const api = `https://api.mealviewer.com/api/v4/school/${encodeURIComponent(schoolId)}/${mdy(start)}/${mdy(end)}/0`;

  const res = await fetch(api, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; mealviewer-calendar)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MealViewer returned ${res.status}`);
  const data = await res.json();
  return {
    schoolName: cleanText(data?.physicalLocation?.name),
    schedules: Array.isArray(data?.menuSchedules) ? data.menuSchedules : [],
  };
}

// Cleans text from MealViewer: control characters out, whitespace collapsed.
function cleanText(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

// Menu names are matched loosely ("Lunch " == "lunch"), since MealViewer data has stray spaces.
function sameName(a, b) {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

async function fetchMenuNames(config) {
  const { schoolName, schedules } = await fetchSchedules(config);
  const names = new Set();
  for (const schedule of schedules) {
    for (const block of schedule.menuBlocks ?? []) {
      const name = cleanText(block.blockName);
      if (name) names.add(name);
    }
  }
  return { schoolName, menuNames: [...names].sort() };
}

function isAllCaps(name) {
  return name === name.toUpperCase() && /[A-Z]/.test(name);
}

async function fetchMenu(config) {
  const { meal } = config;
  const { schedules } = await fetchSchedules(config);

  const days = [];
  for (const schedule of schedules) {
    const date = String(schedule.dateInformation?.dateFull ?? "").slice(0, 10);
    const block = (schedule.menuBlocks ?? []).find((b) => sameName(b.blockName, meal));
    // A malformed date (e.g. month 13) skips just that day rather than failing the whole feed.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || !block) continue;

    const items = [];
    let theme = null;
    for (const line of block.cafeteriaLineList?.data ?? []) {
      // Skip a separate preschool / 3-5 year old serving line some elementary schools list,
      // so the feed shows the regular menu rather than mixing in the little-kids' line.
      if (SKIP_LINE.test(cleanText(line.name))) continue;
      for (const item of line.foodItemList?.data ?? []) {
        const name = cleanText(item.item_Name);
        const themeMatch = name.match(/^\*(.+)\*$/); // e.g. "*HOLIDAY MEAL!*"
        if (themeMatch) {
          theme = titleCase(themeMatch[1]);
          continue;
        }
        const group = classifyType(item.item_Type);
        if (name && group) items.push({ type: group, name });
      }
    }

    // Section headers like "FEATURED ENTREES" are in capitals. Some schools type every dish in
    // capitals too, so only treat capitals as a header when most of the menu isn't in capitals.
    const capsCount = items.filter((item) => isAllCaps(item.name)).length;
    const capsIsHeader = capsCount * 2 < items.length;

    const groups = Object.fromEntries(Object.keys(KEEP_TYPES).map((type) => [type, []]));
    for (const item of items) {
      let { name } = item;
      if (isAllCaps(name)) {
        if (capsIsHeader || HEADER_NAME.test(name)) continue;
        name = titleCase(name);
      }
      if (isCondiment(name)) continue;
      const group = groups[item.type];
      if (!group.includes(name)) group.push(name);
    }
    if (Object.values(groups).some((group) => group.length)) days.push({ date, theme, groups });
  }
  return days;
}

// The event/meal title: the entrées (minus everyday staples), falling back through the other
// groups so a day that's only fruit still gets a title. Prefixed with any theme ("Holiday Meal").
function dayTitle({ theme, groups }) {
  const mains = groups.ENTREES.filter((name) => !TITLE_SKIP.test(name));
  const dishes = [mains, ...Object.values(groups)].find((items) => items.length).join(" / ");
  return theme ? `${theme} ${dishes}` : dishes;
}

// The full breakdown: one "Label: a, b, c" line per non-empty group, in KEEP_TYPES order.
function dayDescription({ groups }) {
  return Object.entries(KEEP_TYPES)
    .filter(([type]) => groups[type].length)
    .map(([type, label]) => `${label}: ${groups[type].join(", ")}`)
    .join("\n");
}

function buildCalendar(days, { feedName, schoolId, timezone, calendarName, eventPrefix }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//mealviewer-calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${timezone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  for (const day of days) {
    const { date } = day;
    const ymd = date.replace(/-/g, "");
    const next = addDays(date, 1).replace(/-/g, "");
    const title = dayTitle(day);
    const description = dayDescription(day);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${feedName}-${schoolId}-${ymd}@school-lunch`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${escapeText(`${eventPrefix} ${title}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function isCondiment(name) {
  const lower = name.toLowerCase();
  if (CONDIMENTS.has(lower) || GARNISH.test(name)) return true;
  return CONDIMENT_SUFFIX.test(name) && !SERVED_WITH.test(name);
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function escapeText(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
    .replace(/[\x00-\x1f\x7f]/g, ""); // any remaining control characters would break the line structure
}

// RFC 5545: lines longer than 75 octets are split, continuation lines start with a space.
function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const len = encoder.encode(ch).length;
    const limit = parts.length ? 74 : 75; // continuation lines lose one octet to the leading space
    if (size + len > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function todayInTZ(timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mdy(ymd) {
  const [y, m, d] = ymd.split("-");
  return `${m}-${d}-${y}`;
}

// ---------------------------------------------------------------------------
// Skylight Meals push (optional). The ICS feeds above are the primary output; this
// additionally mirrors each feed's menu into the Skylight Meals planner via Skylight's
// unofficial API, so lunches show in the Meals view as well as the calendar.
//
// Enabled only when SKYLIGHT_EMAIL + SKYLIGHT_PASSWORD (or SKYLIGHT_ACCESS_TOKEN, mainly
// for testing) are set. Each feed lands in the Skylight meal category matching its meal
// word (lunch -> "Lunch"). Entries we created are recognised by their title prefix (e.g.
// "🍽 Adams Lunch:"), so re-runs replace our own stale entries and never touch meals you
// added by hand. The API is unofficial and may change without notice.
// ---------------------------------------------------------------------------

const SKYLIGHT_BASE = "https://app.ourskylight.com";
const SKYLIGHT_CLIENT_ID = "skylight-mobile";
const SKYLIGHT_REDIRECT_URI = "skylight-family://welcome";
const SKYLIGHT_SCOPE = "everything";
const SKYLIGHT_API_VERSION = "2026-10-15";
const SKYLIGHT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Our meal word -> the Skylight category label it maps to.
const SKYLIGHT_CATEGORY = { Lunch: "Lunch", Breakfast: "Breakfast", Snack: "Snack", Supper: "Dinner" };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A minimal per-host cookie jar, so the login session survives the redirect chain.
function makeJar() {
  const hosts = new Map();
  return {
    store(url, res) {
      const host = new URL(url).host;
      const set = res.headers.getSetCookie?.() ?? [];
      if (!set.length) return;
      const m = hosts.get(host) ?? new Map();
      for (const c of set) {
        const pair = c.split(";")[0];
        const i = pair.indexOf("=");
        if (i > 0) m.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      hosts.set(host, m);
    },
    header(url) {
      const m = hosts.get(new URL(url).host);
      return m && m.size ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
    },
  };
}

// Log in with the OAuth2 Authorization-Code + PKCE flow the Skylight apps use (the legacy
// email/password /api/sessions endpoint is retired). Returns the access token.
async function skylightLogin(email, password) {
  const jar = makeJar();
  const go = async (method, url, { headers = {}, body } = {}) => {
    const cookie = jar.header(url);
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": SKYLIGHT_BROWSER_UA, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body,
      redirect: "manual",
    });
    jar.store(url, res);
    return res;
  };
  const absolute = (loc) => (loc.startsWith("http") ? loc : SKYLIGHT_BASE + loc);

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: SKYLIGHT_CLIENT_ID,
    redirect_uri: SKYLIGHT_REDIRECT_URI,
    scope: SKYLIGHT_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
  });

  // 1. Load the login form (following any http redirects), and read its CSRF token.
  let res = await go("GET", `${SKYLIGHT_BASE}/oauth/authorize?${params}`);
  for (let hop = 0; hop < 10 && REDIRECT_STATUSES.has(res.status); hop++) {
    const loc = res.headers.get("location");
    if (!loc || loc.startsWith("skylight-family:")) break;
    res = await go("GET", absolute(loc));
  }
  const csrf = (await res.text()).match(/name="authenticity_token"[^>]*value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error(`Could not load Skylight login form (status ${res.status})`);

  // 2. Submit credentials and chase redirects to skylight-family://welcome?code=...
  res = await go("POST", `${SKYLIGHT_BASE}/auth/session`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ authenticity_token: csrf, email, password }).toString(),
  });
  let loc = res.headers.get("location");
  for (let hop = 0; hop < 8 && loc && !loc.startsWith("skylight-family:"); hop++) {
    res = await go("GET", absolute(loc));
    loc = res.headers.get("location");
  }
  if (!loc || !loc.startsWith("skylight-family:")) throw new Error("Skylight login rejected (check email/password)");
  const q = new URL(loc.replace("skylight-family:", "https:")).searchParams;
  if (q.get("state") !== state) throw new Error("Skylight OAuth state mismatch");
  const code = q.get("code");
  if (!code) throw new Error("Skylight authorization code missing");

  // 3. Exchange the code for tokens.
  const tokenRes = await go("POST", `${SKYLIGHT_BASE}/oauth/token`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: SKYLIGHT_CLIENT_ID,
      code,
      redirect_uri: SKYLIGHT_REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Skylight token exchange failed (HTTP ${tokenRes.status})`);
  const token = (await tokenRes.json())?.access_token;
  if (!token) throw new Error("Skylight token response had no access_token");
  return token;
}

async function skylightApi(token, method, path, body) {
  const res = await fetch(`${SKYLIGHT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": SKYLIGHT_BROWSER_UA,
      "Skylight-Api-Version": SKYLIGHT_API_VERSION,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`Skylight ${method} ${path} -> ${res.status}: ${String(text).slice(0, 200)}`);
  return data;
}

// Mirror every configured feed's menu into the Skylight Meals planner.
export async function syncSkylight(env) {
  const token = env.SKYLIGHT_ACCESS_TOKEN || (env.SKYLIGHT_EMAIL && env.SKYLIGHT_PASSWORD
    ? await skylightLogin(env.SKYLIGHT_EMAIL, env.SKYLIGHT_PASSWORD)
    : null);
  if (!token) return { skipped: "SKYLIGHT_EMAIL/SKYLIGHT_PASSWORD not set" };

  const feeds = [...readFeeds(env).values()].filter((feed) => !feed.error && feed.skylight);
  if (!feeds.length) return { skipped: "no feeds opted in to Skylight" };

  // Find the frame (the Skylight device/board). Explicit id wins; otherwise the only frame.
  let frameId = env.SKYLIGHT_FRAME_ID;
  if (!frameId) {
    const frames = (await skylightApi(token, "GET", "/api/frames"))?.data ?? [];
    if (frames.length !== 1) throw new Error(`Set SKYLIGHT_FRAME_ID: found ${frames.length} frames`);
    frameId = frames[0].id;
  }

  // Map each Skylight meal category label (lowercased) to its id.
  const categories = (await skylightApi(token, "GET", `/api/frames/${frameId}/meals/categories`))?.data ?? [];
  const categoryByLabel = new Map(categories.map((c) => [String(c.attributes?.label ?? "").toLowerCase(), c.id]));

  const timezone = env.TIMEZONE || feeds[0].timezone || "America/New_York";
  const today = todayInTZ(timezone);
  const dateMax = addDays(today, DAYS_AHEAD);

  // Everything we want in Skylight after this run: one entry per (feed, date).
  const desired = new Map(); // key -> { date, categoryId, summary, note }
  const prefixes = [];
  for (const feed of feeds) {
    prefixes.push(feed.eventPrefix);
    const label = SKYLIGHT_CATEGORY[mealLabel(feed.meal).word] ?? mealLabel(feed.meal).word;
    const categoryId = categoryByLabel.get(label.toLowerCase());
    if (!categoryId) {
      console.warn(`Skylight: no "${label}" meal category for feed "${feed.feedName}"; skipping`);
      continue;
    }
    for (const day of await fetchMenu(feed)) {
      if (day.date < today || day.date > dateMax) continue;
      const summary = `${feed.eventPrefix} ${dayTitle(day)}`;
      const note = dayDescription(day);
      desired.set(`${categoryId}|${day.date}|${summary}`, { date: day.date, categoryId, summary, note });
    }
  }

  // Existing sittings we created (by title prefix), flattened to one record per date.
  // Skylight's date_max is exclusive, so read a couple of days past dateMax or the last
  // menu day would never be seen and would be recreated (duplicated) on every run.
  const readMax = addDays(dateMax, 2);
  const sittings = (await skylightApi(token, "GET", `/api/frames/${frameId}/meals/sittings?date_min=${today}&date_max=${readMax}`))?.data ?? [];
  const stale = [];
  for (const s of sittings) {
    const summary = s.attributes?.summary ?? "";
    if (!prefixes.some((p) => summary.startsWith(p))) continue; // leave hand-added meals alone
    const categoryId = s.relationships?.meal_category?.data?.id;
    const note = s.attributes?.note ?? "";
    for (const date of s.attributes?.instances ?? []) {
      const key = `${categoryId}|${date}|${summary}`;
      const want = desired.get(key);
      if (want && want.note === note) desired.delete(key); // already correct, keep it
      else stale.push({ id: s.id, date }); // ours but changed/removed -> delete
    }
  }

  let created = 0;
  let deleted = 0;
  for (const { id, date } of stale) {
    await skylightApi(token, "DELETE", `/api/frames/${frameId}/meals/sittings/${id}/instances/${date}`);
    deleted++;
  }
  for (const { date, categoryId, summary, note } of desired.values()) {
    await skylightApi(token, "POST", `/api/frames/${frameId}/meals/sittings`, {
      date,
      meal_category_id: categoryId,
      summary,
      note,
      saveToRecipeBox: false,
    });
    created++;
  }

  return { frameId, created, deleted, kept: sittings.length - stale.length };
}
