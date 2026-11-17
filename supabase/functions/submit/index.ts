// BilişimPano — ilan açma ve teklif bırakma için tek giriş noktası.
// Sıra: Turnstile doğrulaması -> IP bazlı hız sınırı -> RPC (service_role).
// İlan açma/teklif RPC'lerinin anon yetkisi kapalıdır; yalnızca bu fonksiyon çağırabilir.
// Gerekli secret'lar: TURNSTILE_SECRET, IP_SALT. İsteğe bağlı: ALLOWED_ORIGINS (virgülle ayrılmış).

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TS_SECRET = Deno.env.get('TURNSTILE_SECRET');
const IP_SALT = Deno.env.get('IP_SALT');
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Saatlik IP başına sınırlar
const LIMITS: Record<string, { max: number; win: number }> = {
  create_listing: { max: 5, win: 3600 },
  create_offer: { max: 20, win: 3600 },
};
// Yalnızca beklenen argümanlar RPC'ye iletilir
const ARGS: Record<string, string[]> = {
  create_listing: ['p_category', 'p_city', 'p_district', 'p_description'],
  create_offer: ['p_listing_id', 'p_name', 'p_phone', 'p_note'],
};

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  const allow = ORIGINS.length === 0 ? '*' : (ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, 405, { message: 'method_not_allowed' });
  if (!TS_SECRET || !IP_SALT) return json(req, 500, { message: 'server_not_configured' });

  let body: any;
  try { body = await req.json(); } catch { return json(req, 400, { message: 'bad_request' }); }
  const { action, token, payload } = body ?? {};
  if (typeof action !== 'string' || !Object.hasOwn(LIMITS, action)) return json(req, 400, { message: 'bad_action' });
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return json(req, 403, { message: 'captcha_failed' });
  if (typeof payload !== 'object' || payload === null) return json(req, 400, { message: 'bad_request' });

  const ip = (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  // 1) Turnstile doğrulaması (token tek kullanımlıktır)
  try {
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: TS_SECRET, response: token, remoteip: ip }),
    });
    const vr = await v.json();
    if (!vr.success) return json(req, 403, { message: 'captcha_failed' });
  } catch {
    return json(req, 503, { message: 'captcha_unavailable' });
  }

  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

  // 2) IP bazlı hız sınırı (IP tuzlu hash olarak saklanır)
  const ipHash = await sha256(`${IP_SALT}:${ip}`);
  const L = LIMITS[action];
  const rr = await fetch(`${SB_URL}/rest/v1/rpc/check_rate`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ p_ip_hash: ipHash, p_action: action, p_limit: L.max, p_window_seconds: L.win }),
  });
  if (!rr.ok) return json(req, 500, { message: 'rate_check_failed' });
  if ((await rr.json()) !== true) return json(req, 429, { message: 'rate_limited' });

  // 3) RPC çağrısı: yalnızca beklenen alanlar, hepsi metin
  const args: Record<string, string> = {};
  for (const k of ARGS[action]) args[k] = typeof payload[k] === 'string' ? payload[k] : '';
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${action}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const text = await res.text();
  if (res.status === 204 || text === '') return new Response(null, { status: 204, headers: cors(req) });
  return new Response(text, { status: res.status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
});
