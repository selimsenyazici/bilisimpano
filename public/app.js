// BilişimPano — istemci mantığı. Güvenlik notları:
//  * Kullanıcı verisi yalnızca textContent / value ile DOM'a yazılır (innerHTML YOK).
//  * Telefon numarası listeye hiç gelmez; WhatsApp bağlantısı tıklamada üretilir.
import { SUPABASE_URL, SUPABASE_ANON_KEY, TURNSTILE_SITEKEY } from './config.js';

const CATEGORIES = {
  format: 'Format & Kurulum', donanim: 'Donanım Onarımı', ag: 'Ağ Kurulumu',
  kamera: 'Kamera Sistemleri', yazilim: 'Yazılım Desteği', web: 'Web Desteği',
  veri: 'Veri Kurtarma', diger: 'Diğer'
};
const ICONS = {format:'💽',donanim:'🔧',ag:'🌐',kamera:'📹',yazilim:'🧩',web:'🕸️',veri:'💾',diger:'🧰'};
const CITIES = ['Adana','Adıyaman','Afyonkarahisar','Ağrı','Aksaray','Amasya','Ankara','Antalya','Ardahan','Artvin','Aydın','Balıkesir','Bartın','Batman','Bayburt','Bilecik','Bingöl','Bitlis','Bolu','Burdur','Bursa','Çanakkale','Çankırı','Çorum','Denizli','Diyarbakır','Düzce','Edirne','Elazığ','Erzincan','Erzurum','Eskişehir','Gaziantep','Giresun','Gümüşhane','Hakkari','Hatay','Iğdır','Isparta','İstanbul','İzmir','Kahramanmaraş','Karabük','Karaman','Kars','Kastamonu','Kayseri','Kırıkkale','Kırklareli','Kırşehir','Kilis','Kocaeli','Konya','Kütahya','Malatya','Manisa','Mardin','Mersin','Muğla','Muş','Nevşehir','Niğde','Ordu','Osmaniye','Rize','Sakarya','Samsun','Siirt','Sinop','Sivas','Şanlıurfa','Şırnak','Tekirdağ','Tokat','Trabzon','Tunceli','Uşak','Van','Yalova','Yozgat','Zonguldak'];

const $ = (s) => document.querySelector(s);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-zÇĞİıÖŞÜçğöşü .-]{2,40}$/;
const PHONE_RE = /^(\+90|90|0)?5\d{9}$/;

// ---------- Supabase REST yardımcısı (SDK'sız, CSP dostu) ----------
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
               'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* yoksay */ }
    throw new Error(msg || res.statusText);
  }
  const txt = await res.text();           // void RPC'ler boş (204) döner
  return txt ? JSON.parse(txt) : null;
}

// ---------- Edge Function: ilan açma / teklif bırakma ----------
async function submit(action, payload, token) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/submit`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token, payload })
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { /* yoksay */ }
  if (!res.ok) throw new Error((data && data.message) || res.statusText);
  return data;
}

// ---------- Select doldurma ----------
function fill(sel, entries, placeholder) {
  sel.replaceChildren();
  const first = document.createElement('option');
  first.value = ''; first.textContent = placeholder;
  sel.append(first);
  for (const [value, label] of entries) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.append(o);
  }
}
const catEntries = Object.entries(CATEGORIES);
const cityEntries = CITIES.map((c) => [c, c]);
fill($('#f-category'), catEntries, 'Seçin');
fill($('#f-city'), cityEntries, 'Seçin');
fill($('#q-category'), catEntries, 'Tüm kategoriler');
fill($('#q-city'), cityEntries, 'Tüm iller');

// ---------- Kategori çipleri ----------
const chips = $('#chips');
function syncChips() {
  for (const b of chips.children) b.setAttribute('aria-pressed', String(b.dataset.k === $('#q-category').value));
}
for (const [k, label] of [['', 'Tümü'], ...catEntries]) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.dataset.k = k;
  b.textContent = k ? `${ICONS[k]} ${label}` : label;
  b.addEventListener('click', () => { $('#q-category').value = k; syncChips(); loadListings(); });
  chips.append(b);
}
$('#q-category').addEventListener('input', syncChips);
syncChips();

// ---------- İlan listesi ----------
const timers = new Set();

function remaining(ms) {
  if (ms <= 0) return 'Süresi doldu';
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)} sa ${m % 60} dk kaldı`;
}

function renderCard(item) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.cat = CATEGORIES[item.category] ? item.category : 'diger';

  const meta = document.createElement('div'); meta.className = 'meta';
  const badge = document.createElement('span'); badge.className = 'badge';
  badge.textContent = `${ICONS[item.category] || '🧰'} ${CATEGORIES[item.category] || 'Diğer'}`;
  const tid = document.createElement('span'); tid.className = 'tid';
  tid.textContent = `#${String(item.id).slice(0, 4).toUpperCase()}`;
  const timer = document.createElement('span'); timer.className = 'timer';
  const expires = new Date(item.expires_at).getTime();
  timer.textContent = remaining(expires - Date.now());
  const cnt = document.createElement('span'); cnt.className = 'tid';
  cnt.textContent = `${item.offer_count || 0} teklif`;
  meta.append(badge, tid, cnt, timer);

  const loc = document.createElement('p'); loc.className = 'loc';
  loc.textContent = `${item.district}, ${item.city}`;
  const desc = document.createElement('p'); desc.className = 'desc';
  desc.textContent = item.description;

  const actions = document.createElement('div'); actions.className = 'actions';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Bu ilana teklif bırak';
  btn.addEventListener('click', () => openOffer(item, btn));
  actions.append(btn);

  card.append(meta, loc, desc, actions);
  timers.add({ card, timer, expires });
  return card;
}

function tick() {
  const now = Date.now();
  for (const t of timers) {
    if (t.expires <= now) { t.card.remove(); timers.delete(t); continue; }
    t.timer.textContent = remaining(t.expires - now);
  }
  $('#empty').hidden = timers.size > 0;
}
setInterval(tick, 30000);

async function loadListings() {
  const p = new URLSearchParams({
    select: 'id,category,city,district,description,expires_at,offer_count',
    order: 'created_at.desc', limit: '50'
  });
  const cat = $('#q-category').value, city = $('#q-city').value;
  const dist = $('#q-district').value.replace(/[^A-Za-zÇĞİıÖŞÜçğöşü .-]/g, '').trim();
  if (CATEGORIES[cat]) p.set('category', `eq.${cat}`);
  if (CITIES.includes(city)) p.set('city', `eq.${city}`);
  if (dist) p.set('district', `ilike.*${dist}*`);
  p.set('expires_at', `gt.${new Date().toISOString()}`);
  try {
    const rows = await api(`listings?${p}`);
    timers.clear();
    $('#list').replaceChildren(...rows.map(renderCard));
    $('#empty').hidden = rows.length > 0;
  } catch {
    $('#list').replaceChildren();
    $('#empty-msg').textContent = 'İlanlar yüklenemedi. Biraz sonra tekrar dene.';
    $('#empty').hidden = false;
  }
}
let debounce;
for (const id of ['#q-category', '#q-city', '#q-district']) {
  $(id).addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadListings, 300); });
}

// ---------- Teklif bırakma (numara yalnızca ilan sahibine gider) ----------
const dlg = $('#offer-dialog'), offerErr = $('#offer-error');
let offerTarget = null;
const showOfferError = (m) => { offerErr.textContent = m; offerErr.hidden = !m; };
const BAD_NOTE = (t) => /(https?:\/\/|www\.|@)/i.test(t) || /5(\D?\d){9}/.test(t);

function openOffer(item, btn) {
  offerTarget = { item, btn };
  $('#offer-for').textContent = `${item.district}, ${item.city}: ${CATEGORIES[item.category] || 'Diğer'}`;
  $('#offer-form').reset(); showOfferError('');
  dlg.showModal();
  tsRender('offer', '#o-turnstile');
}
$('#offer-cancel').addEventListener('click', () => dlg.close());

$('#offer-form').addEventListener('submit', async (e) => {
  e.preventDefault(); showOfferError('');
  const name = $('#o-name').value.trim(), note = $('#o-note').value.trim();
  const phone = $('#o-phone').value.replace(/[\s()-]/g, '');
  if (!/^[A-Za-zÇĞİıÖŞÜçğöşü0-9 .&-]{2,40}$/.test(name)) return showOfferError('Adını ya da firma adını yaz (2-40 karakter, özel işaret yok).');
  if (!PHONE_RE.test(phone)) return showOfferError('Geçerli bir cep numarası gir (05xx xxx xx xx).');
  if (note.length > 200) return showOfferError('Not en fazla 200 karakter olabilir.');
  if (BAD_NOTE(note)) return showOfferError('Notta telefon, bağlantı ya da e-posta olmamalı.');
  if (!ts.tokens.offer) return showOfferError('Lütfen doğrulamayı tamamla.');
  const submitBtn = e.submitter; if (submitBtn) submitBtn.disabled = true;
  try {
    await submit('create_offer', {
      p_listing_id: offerTarget.item.id, p_name: name, p_phone: phone, p_note: note }, ts.tokens.offer);
    dlg.close();
    offerTarget.btn.textContent = 'Teklifin gönderildi'; offerTarget.btn.disabled = true;
  } catch (err) {
    showOfferError(/captcha/.test(err.message) ? 'Doğrulama başarısız oldu, tekrar dene.'
      : /rate_limited/.test(err.message) ? 'Çok fazla deneme yaptın. Biraz sonra tekrar dene.'
      : /duplicate/.test(err.message) ? 'Bu numarayla bu ilana zaten teklif bıraktın.'
      : /too_many_offers/.test(err.message) ? 'Bu ilan en fazla teklif sayısına ulaştı.'
      : /listing_not_found/.test(err.message) ? 'Bu ilan artık yayında değil.'
      : /invalid_phone/.test(err.message) ? 'Telefon numarası geçersiz.'
      : 'Teklif gönderilemedi. Alanları kontrol edip tekrar dene.');
  } finally { tsReset('offer'); if (submitBtn) submitBtn.disabled = false; }
});

// ---------- İstemci tarafı hız sınırı ----------
const RL_KEY = 'ilan_rl';
function rateLimit() {
  try {
    const now = Date.now();
    const t = JSON.parse(localStorage.getItem(RL_KEY) || '[]').filter((x) => now - x < 3600e3);
    if (t.length && now - t[t.length - 1] < 30e3) return 'Lütfen 30 saniye bekle.';
    if (t.length >= 3) return 'Saatte en fazla 3 ilan açabilirsin.';
    return '';
  } catch { return ''; }
}
function markSubmit() {
  try {
    const now = Date.now();
    const t = JSON.parse(localStorage.getItem(RL_KEY) || '[]').filter((x) => now - x < 3600e3);
    localStorage.setItem(RL_KEY, JSON.stringify([...t, now]));
  } catch { /* depolama kapalı olabilir */ }
}

// ---------- Turnstile (her gönderim için tek kullanımlık token) ----------
const ts = { ready: false, ids: {}, tokens: {} };
const tsQueue = [];
window.onTurnstile = () => { ts.ready = true; tsQueue.splice(0).forEach((f) => f()); };
{
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstile';
  s.async = true; document.head.append(s);
}
function tsRender(name, selector) {
  const go = () => {
    if (ts.ids[name] !== undefined) { window.turnstile.reset(ts.ids[name]); ts.tokens[name] = ''; return; }
    ts.ids[name] = window.turnstile.render(selector, {
      sitekey: TURNSTILE_SITEKEY,
      callback: (t) => { ts.tokens[name] = t; },
      'expired-callback': () => { ts.tokens[name] = ''; }
    });
  };
  if (ts.ready) go(); else tsQueue.push(go);
}
function tsReset(name) {
  if (window.turnstile && ts.ids[name] !== undefined) window.turnstile.reset(ts.ids[name]);
  ts.tokens[name] = '';
}
tsRender('listing', '#turnstile');

// ---------- İlanlarım (bu tarayıcıda saklanır) ----------
const MINE_KEY = 'ilan_mine';
function readMine() {
  try {
    const now = Date.now();
    return JSON.parse(localStorage.getItem(MINE_KEY) || '[]')
      .filter((x) => UUID_RE.test(x.id) && UUID_RE.test(x.token) && now - x.t < 48 * 3600e3);
  } catch { return []; }
}
function writeMine(list) { try { localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* yoksay */ } }
function renderMine() {
  const a = readMine(), b = $('#mine-btn');
  b.hidden = a.length === 0; b.textContent = `İlanlarım (${a.length})`;
}
$('#mine-btn').addEventListener('click', () => {
  const box = $('#mine-list'); box.replaceChildren();
  for (const x of readMine()) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ghost'; b.textContent = x.label;
    b.addEventListener('click', () => { location.href = `${location.pathname}?close_id=${x.id}&token=${x.token}`; });
    box.append(b);
  }
  $('#mine-dialog').showModal();
});
$('#mine-close').addEventListener('click', () => $('#mine-dialog').close());

// ---------- İlan oluşturma ----------
const form = $('#listing-form'), errBox = $('#form-error');
const showError = (m) => { errBox.textContent = m; errBox.hidden = !m; };

$('#f-desc').addEventListener('input', (e) => { $('#desc-count').textContent = `${e.target.value.length} / 500`; });

form.addEventListener('submit', async (e) => {
  e.preventDefault(); showError('');
  if ($('#f-website').value) return;                       // honeypot dolu => bot
  const category = $('#f-category').value, city = $('#f-city').value;
  const district = $('#f-district').value.trim(), description = $('#f-desc').value.trim();

  if (!CATEGORIES[category]) return showError('Kategori seç.');
  if (!CITIES.includes(city)) return showError('İl seç.');
  if (!NAME_RE.test(district)) return showError('İlçe adını yalnızca harf kullanarak yaz.');
  if (description.length < 20 || description.length > 500) return showError('Açıklama 20–500 karakter olmalı.');
  if (/(https?:\/\/|www\.|@)/i.test(description) || /5(\D?\d){9}/.test(description))
    return showError('Açıklamada telefon, bağlantı ya da e-posta olmamalı. Yalnızca sorunu yaz.');
  if (!ts.tokens.listing) return showError('Lütfen doğrulamayı tamamla.');
  const limited = rateLimit(); if (limited) return showError(limited);

  const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const [row] = await submit('create_listing', {
      p_category: category, p_city: city, p_district: district, p_description: description
    }, ts.tokens.listing);
    markSubmit();
    const url = `${location.origin}${location.pathname}?close_id=${row.listing_id}&token=${row.close_token}`;
    $('#close-url').value = url;
    writeMine([{ id: row.listing_id, token: row.close_token, t: Date.now(),
      label: `${CATEGORIES[category]} · ${district}` }, ...readMine()]);
    renderMine();
    form.hidden = true; $('#result').hidden = false;
    loadListings();
  } catch (err) {
    showError(/captcha/.test(err.message) ? 'Doğrulama başarısız oldu, tekrar dene.'
            : /rate_limited/.test(err.message) ? 'Çok fazla deneme yaptın. Biraz sonra tekrar dene.'
            : /desc_clean/.test(err.message) ? 'Açıklamada telefon, bağlantı ya da e-posta olmamalı.'
            : 'İlan yayınlanamadı. Alanları kontrol edip tekrar dene.');
    tsReset('listing');
  } finally { btn.disabled = false; }
});

$('#copy-btn').addEventListener('click', async () => {
  const input = $('#close-url');
  try { await navigator.clipboard.writeText(input.value); $('#copy-btn').textContent = 'Kopyalandı'; }
  catch { input.select(); }
});

// ---------- İlan sahibi paneli (?close_id=&token=): teklifleri gör, ilanı kapat ----------
// Link açılınca otomatik kapatmayız: önizleme botları ilanı yanlışlıkla kapatmasın.
const ago = (iso) => {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : `${Math.floor(m / 60)} sa önce`;
};
(function initOwner() {
  const q = new URLSearchParams(location.search);
  const id = q.get('close_id'), token = q.get('token');
  if (!id || !token) return;
  const panel = $('#close-panel'), msg = $('#close-msg'), btn = $('#close-btn'), box = $('#offers');
  const refresh = $('#offers-refresh');
  panel.hidden = false;
  $('.hero-in').classList.add('owner-mode');
  document.body.classList.add('owner-view');
  window.scrollTo(0, 0);
  if (!UUID_RE.test(id) || !UUID_RE.test(token)) {
    msg.textContent = 'Bağlantı geçersiz.'; btn.hidden = true; refresh.hidden = true; return;
  }
  const DEAD = { closed: 'Bu ilan kapatılmış, teklifler silindi.',
                 expired: 'Bu ilanın süresi dolmuş.',
                 invalid: 'Bu bağlantı geçersiz. Doğru bağlantıyı kullandığından emin ol.' };
  async function loadOffers() {
    try {
      const status = await api('rpc/get_listing_status', { method: 'POST', body: { p_id: id, p_token: token } });
      if (status !== 'active') {
        msg.textContent = DEAD[status] || DEAD.invalid;
        box.replaceChildren(); btn.hidden = true; refresh.hidden = true; return;
      }
      const rows = await api('rpc/get_offers', { method: 'POST', body: { p_id: id, p_token: token } });
      box.replaceChildren();
      msg.textContent = rows.length ? `${rows.length} teklif geldi.` : 'Henüz teklif yok. Uzmanlar teklif bıraktıkça burada görünecek.';
      for (const o of rows) {
        const row = document.createElement('article'); row.className = 'offer';
        const av = document.createElement('span'); av.className = 'avatar';
        av.textContent = (o.name[0] || '?').toUpperCase();
        const body = document.createElement('div'); body.className = 'offer-body';
        const who = document.createElement('strong'); who.textContent = o.name;
        const when = document.createElement('small'); when.textContent = ago(o.created_at);
        const note = document.createElement('p'); note.textContent = o.note || 'Not bırakılmadı.';
        const wa = document.createElement('button');
        wa.type = 'button'; wa.className = 'btn wa sm'; wa.textContent = "WhatsApp'tan yaz";
        wa.addEventListener('click', () => {
          const text = `Merhaba, BilişimPano'daki ilanıma bıraktığınız teklif için yazıyorum.`;
          window.open(`https://wa.me/${o.phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        });
        body.append(who, when, note, wa);
        row.append(av, body); box.append(row);
      }
    } catch { msg.textContent = 'Teklifler yüklenemedi. Tekrar dene.'; }
  }
  refresh.addEventListener('click', loadOffers);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const ok = await api('rpc/close_listing', { method: 'POST', body: { p_id: id, p_token: token } });
      msg.textContent = ok ? 'İlanın yayından kaldırıldı, teklifler silindi. Teşekkürler!' : 'Bağlantı geçersiz ya da ilan zaten kapalı.';
      box.replaceChildren(); btn.hidden = true; refresh.hidden = true;
      if (ok) { writeMine(readMine().filter((x) => x.id !== id)); renderMine(); loadListings(); }
    } catch { msg.textContent = 'İşlem başarısız. Tekrar dene.'; btn.disabled = false; }
  });
  loadOffers();
})();

renderMine();
loadListings();
