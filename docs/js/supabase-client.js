// gradebook/supabase-client.js
const SUPABASE_URL = 'https://szskcfggifptfemjkuwy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bhV6rnA7fnvQePhyQQUB0g__5aaHoTx';

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);