// whoop-pull.js
// Runs on a schedule (GitHub Actions) or locally (`npm run pull`).
// It: (1) refreshes the WHOOP access token using the stored refresh token,
// (2) fetches the last few days of recovery / sleep / cycle / workout data from
// the WHOOP v2 API, and (3) upserts it into your Supabase tables.
//
// Re-running is always safe: the unique(date) / unique(workout_id) constraints
// mean existing rows get updated in place instead of duplicated.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SECRET,
} = process.env;

for (const [k, v] of Object.entries({
  WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SECRET,
})) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer';

// How far back to look each run. 3 days covers late-scored data and any missed runs.
const LOOKBACK_DAYS = 3;
const START = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, {
  auth: { persistSession: false },
});

// ---- Token handling (WHOOP rotates refresh tokens, so we save the new one) ----
async function getAccessToken() {
  const { data, error } = await supabase
    .from('whoop_tokens').select('*').eq('id', 1).single();
  if (error || !data?.refresh_token) {
    throw new Error('No refresh token found. Run "npm run connect" first.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      scope: 'offline',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const t = await res.json();

  await supabase.from('whoop_tokens').upsert({
    id: 1,
    access_token: t.access_token,
    // WHOOP rotates refresh tokens — keep the new one, fall back to old if absent
    refresh_token: t.refresh_token ?? data.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  return t.access_token;
}

// ---- Paginated GET helper ----
async function fetchAll(path, token, extraParams = {}) {
  const out = [];
  let nextToken;
  do {
    const qs = new URLSearchParams({ limit: '25', start: START, ...extraParams });
    if (nextToken) qs.set('nextToken', nextToken);
    const res = await fetch(`${API}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    const json = await res.json();
    out.push(...(json.records ?? []));
    nextToken = json.next_token;
  } while (nextToken);
  return out;
}

// ---- Small date helpers ----
const dateOf = (iso) => (iso ? iso.slice(0, 10) : null);

// Convert a UTC timestamp to the member's LOCAL calendar date using WHOOP's offset
function localDate(iso, tzOffset) {
  const d = new Date(iso);
  if (tzOffset && /^[+-]\d{2}:\d{2}$/.test(tzOffset)) {
    const sign = tzOffset[0] === '-' ? -1 : 1;
    const [h, m] = tzOffset.slice(1).split(':').map(Number);
    return new Date(d.getTime() + sign * (h * 60 + m) * 60000).toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

const isScored = (r) => r.score_state === 'SCORED' && r.score;

async function upsert(table, rows, onConflict) {
  if (!rows.length) return 0;
  const { error } = await supabase.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`Upsert into ${table} failed: ${error.message}`);
  return rows.length;
}

async function main() {
  const token = await getAccessToken();

  // ---- Recovery -> whoop_recovery ----
  const recoveries = await fetchAll('/v2/recovery', token);
  const recRows = recoveries.filter(isScored).map((r) => ({
    date: dateOf(r.created_at),
    recovery_score: r.score.recovery_score,
    resting_hr: r.score.resting_heart_rate,
    hrv_ms: r.score.hrv_rmssd_milli,
    spo2: r.score.spo2_percentage,
    skin_temp_c: r.score.skin_temp_celsius,
    raw: r,
  })).filter((r) => r.date);

  // ---- Sleep -> whoop_sleep (main sleeps only, not naps) ----
  const sleeps = await fetchAll('/v2/activity/sleep', token);
  const sleepRows = sleeps.filter((s) => isScored(s) && !s.nap).map((s) => {
    const st = s.score.stage_summary ?? {};
    const asleepMs = (st.total_light_sleep_time_milli ?? 0)
      + (st.total_slow_wave_sleep_time_milli ?? 0)
      + (st.total_rem_sleep_time_milli ?? 0);
    return {
      date: localDate(s.start, s.timezone_offset),
      sleep_performance: s.score.sleep_performance_percentage,
      hours_slept: +(asleepMs / 3600000).toFixed(2),
      sleep_efficiency: s.score.sleep_efficiency_percentage,
      respiratory_rate: s.score.respiratory_rate,
      disturbances: st.disturbance_count,
      raw: s,
    };
  });

  // ---- Cycle (strain) -> whoop_strain ----
  const cycles = await fetchAll('/v2/cycle', token);
  const strainRows = cycles.filter(isScored).map((c) => ({
    date: localDate(c.start, c.timezone_offset),
    day_strain: c.score.strain,
    avg_hr: c.score.average_heart_rate,
    max_hr: c.score.max_heart_rate,
    kilojoules: c.score.kilojoule,
    raw: c,
  }));

  // ---- Workouts -> whoop_workouts ----
  const workouts = await fetchAll('/v2/activity/workout', token);
  const workoutRows = workouts.filter(isScored).map((w) => ({
    workout_id: String(w.id),
    date: localDate(w.start, w.timezone_offset),
    sport: w.sport_name ?? null,
    strain: w.score.strain,
    avg_hr: w.score.average_heart_rate,
    max_hr: w.score.max_heart_rate,
    kilojoules: w.score.kilojoule,
    duration_min: +((new Date(w.end) - new Date(w.start)) / 60000).toFixed(1),
    raw: w,
  }));

  // De-dupe rows sharing a date before upserting (keep the last one)
  const byDate = (rows) => Array.from(
    rows.reduce((m, r) => m.set(r.date, r), new Map()).values()
  );

  const counts = {
    recovery: await upsert('whoop_recovery', byDate(recRows), 'date'),
    sleep: await upsert('whoop_sleep', byDate(sleepRows), 'date'),
    strain: await upsert('whoop_strain', byDate(strainRows), 'date'),
    workouts: await upsert('whoop_workouts', workoutRows, 'workout_id'),
  };

  console.log('WHOOP pull complete:', counts);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
