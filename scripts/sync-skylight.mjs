// Runs the Skylight Meals sync (see src/index.js `syncSkylight`) from environment variables.
// Used by the scheduled GitHub Action; can also be run locally.
//
//   SKYLIGHT_EMAIL / SKYLIGHT_PASSWORD   Skylight login (OAuth2 PKCE under the hood)
//   FEEDS                                 same JSON as wrangler.toml's [vars.FEEDS], e.g.
//                                         {"adams-lunch":{"SCHOOL_ID":"...","SCHOOL_NAME":"...","MEAL":"Lunch"}}
//   TIMEZONE                              IANA zone, e.g. America/Chicago
//   SKYLIGHT_FRAME_ID (optional)          only needed if the account has several frames
//   SKYLIGHT_ACCESS_TOKEN (optional)      use a token instead of email/password (testing)

import { syncSkylight } from "../src/index.js";

const result = await syncSkylight({
  SKYLIGHT_EMAIL: process.env.SKYLIGHT_EMAIL,
  SKYLIGHT_PASSWORD: process.env.SKYLIGHT_PASSWORD,
  SKYLIGHT_ACCESS_TOKEN: process.env.SKYLIGHT_ACCESS_TOKEN,
  SKYLIGHT_FRAME_ID: process.env.SKYLIGHT_FRAME_ID,
  TIMEZONE: process.env.TIMEZONE,
  FEEDS: process.env.FEEDS,
});

console.log("Skylight sync:", JSON.stringify(result));
if (result?.skipped) {
  console.error(`Nothing synced: ${result.skipped}`);
  process.exit(1);
}
