// Genel (public) yapılandırma. anon key gizli değildir; güvenlik RLS + RPC ile sağlanır.
export const SUPABASE_URL = 'https://atwwmnudvyudoxdivxml.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0d3dtbnVkdnl1ZG94ZGl2eG1sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NTE1MTAsImV4cCI6MjExMDIyNzUxMH0.egZBKa8FlWmCE4-7aHfiRFm5mzdcOYLxI2ZjyhONWmg';
// Cloudflare Turnstile site key (herkese açık anahtar; gizli anahtar yalnızca Supabase'te durur).
export const TURNSTILE_SITEKEY = '0x4AAAAAAGB5QzL90CQvLzLa';
