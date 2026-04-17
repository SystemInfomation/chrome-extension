/**
 * Supabase client for the Watson Control Tower dashboard.
 *
 * Uses the Supabase JS client to query activity, alerts, and custom filters
 * directly from the Supabase PostgreSQL instance via PostgREST.
 *
 * The URL and publishable (anon) key are safe to include in client-side code —
 * they are designed for public/browser use.  Row Level Security (RLS) policies
 * on the Supabase project control what data the client can access.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qwxixzdsfrckcqeuried.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_BCU-thKuvRJUWcdxqDYhlw_rUEF6SWQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
