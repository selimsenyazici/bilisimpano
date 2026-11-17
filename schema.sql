-- =====================================================================
-- BilişimPano — Supabase şeması (güncel, tek dosya; boş bir projede çalışır)
-- Supabase SQL Editor'de tek seferde çalıştırın.
--
-- Güvenlik modeli:
--   * Üyelik yok. Müşterinin telefon numarası HİÇ alınmaz/saklanmaz.
--   * Uzmanlar ilana teklif bırakır (ad + WhatsApp + not). Teklifler herkese
--     kapalıdır; yalnızca ilan sahibi, kapatma token'ıyla okuyabilir.
--   * Tablolara doğrudan INSERT/UPDATE/DELETE kapalıdır; tüm yazma ve
--     okuma işlemleri SECURITY DEFINER RPC'ler üzerinden yapılır.
--   * close_token ham haliyle saklanmaz (SHA-256 hash). Ham token yalnızca
--     ilan oluşturulurken bir kez döner.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- İlanlar ----------
create table if not exists public.listings (
  id               uuid primary key default gen_random_uuid(),
  category         text not null
                   check (category in ('format','donanim','ag','kamera','yazilim','web','veri','diger')),
  city             text not null check (char_length(city) between 2 and 30),
  district         text not null
                   check (char_length(district) between 2 and 40
                          and district ~ '^[A-Za-zÇĞİıÖŞÜçğöşü .-]+$'),
  description      text not null check (char_length(description) between 20 and 500),
  close_token_hash text not null check (char_length(close_token_hash) = 64),
  is_active        boolean not null default true,
  offer_count      integer not null default 0 check (offer_count between 0 and 10),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours',
  -- Açıklamada telefon, bağlantı ya da e-posta olamaz (ilanlar herkese açık)
  constraint listings_desc_clean
    check (description !~* '(https?://|www\.|@)' and description !~ '5(\D?\d){9}')
);
create index if not exists listings_active_idx on public.listings (is_active, expires_at desc);

-- ---------- Teklifler (herkese kapalı) ----------
create table if not exists public.offers (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  name       text not null check (name ~ '^[A-Za-zÇĞİıÖŞÜçğöşü0-9 .&-]{2,40}$'),
  phone      text not null check (phone ~ '^905[0-9]{9}$'),            -- 90 + 5xx xxx xx xx
  note       text not null default ''
             check (char_length(note) <= 200
                    and note !~* '(https?://|www\.|@)' and note !~ '5(\D?\d){9}'),
  created_at timestamptz not null default now(),
  unique (listing_id, phone)                                            -- aynı numara tek teklif
);
create index if not exists offers_listing_idx on public.offers (listing_id);

-- ---------- RLS ve yetkiler ----------
alter table public.listings enable row level security;
alter table public.offers   enable row level security;

revoke all on public.listings from anon, authenticated;
revoke all on public.offers   from anon, authenticated;

-- anon yalnızca güvenli sütunları okuyabilir (close_token_hash okunamaz)
grant select (id, category, city, district, description, created_at, expires_at, offer_count)
  on public.listings to anon;

drop policy if exists "public read active listings" on public.listings;
create policy "public read active listings"
  on public.listings for select to anon
  using (is_active = true and expires_at > now());

-- INSERT / UPDATE / DELETE için politika yok => RLS hepsini reddeder.
-- offers için hiçbir politika/yetki yok => yalnızca RPC'ler erişir.

-- ---------- RPC: ilan oluştur ----------
create or replace function public.create_listing(
  p_category text, p_city text, p_district text, p_description text
) returns table (listing_id uuid, close_token uuid)
language plpgsql security definer
set search_path = public, extensions
as $$
declare v_token uuid := gen_random_uuid(); v_id uuid;
begin
  insert into public.listings (category, city, district, description, close_token_hash)
  values (p_category, trim(p_city), trim(p_district), trim(p_description),
          encode(digest(v_token::text, 'sha256'), 'hex'))
  returning listings.id into v_id;
  return query select v_id, v_token;
end $$;

-- ---------- RPC: teklif bırak ----------
create or replace function public.create_offer(
  p_listing_id uuid, p_name text, p_phone text, p_note text
) returns void
language plpgsql security definer
set search_path = public
as $$
declare v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s\-\(\)]', '', 'g');
begin
  -- TR telefonunu 905xxxxxxxxx biçimine normalize et
  if    v_phone ~ '^\+90' then v_phone := substr(v_phone, 2);
  elsif v_phone ~ '^0'    then v_phone := '9' || v_phone;
  elsif v_phone ~ '^5'    then v_phone := '90' || v_phone;
  end if;
  if v_phone !~ '^905[0-9]{9}$' then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if not exists (select 1 from public.listings l
                  where l.id = p_listing_id and l.is_active and l.expires_at > now()) then
    raise exception 'listing_not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.offers o where o.listing_id = p_listing_id) >= 10 then
    raise exception 'too_many_offers' using errcode = '54000';
  end if;
  begin
    insert into public.offers (listing_id, name, phone, note)
    values (p_listing_id, trim(p_name), v_phone, trim(coalesce(p_note, '')));
  exception when unique_violation then
    raise exception 'duplicate_offer' using errcode = '23505';
  end;
  update public.listings set offer_count = offer_count + 1 where id = p_listing_id;
end $$;

-- ---------- RPC: teklifleri oku (yalnızca ilan sahibi) ----------
create or replace function public.get_offers(p_id uuid, p_token uuid)
returns table (name text, phone text, note text, created_at timestamptz)
language sql security definer stable
set search_path = public, extensions
as $$
  select o.name, o.phone, o.note, o.created_at
    from public.offers o
    join public.listings l on l.id = o.listing_id
   where l.id = p_id
     and l.close_token_hash = encode(digest(p_token::text, 'sha256'), 'hex')
   order by o.created_at;
$$;

-- ---------- RPC: bağlantı durumu (yalnızca doğru token ile anlamlı) ----------
create or replace function public.get_listing_status(p_id uuid, p_token uuid)
returns text
language sql security definer stable
set search_path = public, extensions
as $$
  select coalesce((
    select case when not l.is_active then 'closed'
                when l.expires_at <= now() then 'expired'
                else 'active' end
      from public.listings l
     where l.id = p_id
       and l.close_token_hash = encode(digest(p_token::text, 'sha256'), 'hex')
  ), 'invalid');
$$;

-- ---------- RPC: ilanı kapat (token doğrulamalı; teklifler silinir) ----------
create or replace function public.close_listing(p_id uuid, p_token uuid)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  update public.listings set is_active = false
   where id = p_id and is_active
     and close_token_hash = encode(digest(p_token::text, 'sha256'), 'hex');
  if found then
    delete from public.offers where listing_id = p_id;
    return true;
  end if;
  return false;   -- yanlış id/token için aynı yanıt
end $$;

-- ---------- Fonksiyon yetkileri ----------
revoke execute on function public.create_listing(text,text,text,text)    from public, authenticated;
revoke execute on function public.create_offer(uuid,text,text,text)      from public, authenticated;
revoke execute on function public.get_offers(uuid,uuid)                  from public, authenticated;
revoke execute on function public.get_listing_status(uuid,uuid)          from public, authenticated;
revoke execute on function public.close_listing(uuid,uuid)               from public, authenticated;
grant  execute on function public.create_listing(text,text,text,text)    to service_role;  -- yalnızca Edge Function
grant  execute on function public.create_offer(uuid,text,text,text)      to service_role;  -- yalnızca Edge Function
grant  execute on function public.get_offers(uuid,uuid)                  to anon;
grant  execute on function public.get_listing_status(uuid,uuid)          to anon;
grant  execute on function public.close_listing(uuid,uuid)               to anon;

-- ---------- IP bazlı hız sınırı (Edge Function kullanır; IP tuzlu hash olarak tutulur) ----------
create table if not exists public.rate_limits (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  action     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limits_lookup_idx on public.rate_limits (ip_hash, action, created_at desc);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.check_rate(
  p_ip_hash text, p_action text, p_limit integer, p_window_seconds integer
) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare n integer;
begin
  select count(*) into n from public.rate_limits
   where ip_hash = p_ip_hash and action = p_action
     and created_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_limit then return false; end if;
  insert into public.rate_limits (ip_hash, action) values (p_ip_hash, p_action);
  return true;
end $$;
revoke execute on function public.check_rate(text,text,integer,integer) from public, anon, authenticated;
grant  execute on function public.check_rate(text,text,integer,integer) to service_role;

-- ---------- Fiziksel temizlik (süresi dolan ilanlar + teklifler/numaralar) ----------
create or replace function public.purge_expired_listings() returns void
language sql security definer set search_path = public as $$
  delete from public.listings where expires_at < now() - interval '1 day';  -- offers cascade ile silinir
  delete from public.rate_limits where created_at < now() - interval '1 day';
$$;
revoke execute on function public.purge_expired_listings() from public, anon, authenticated;

-- pg_cron eklentisini açtıktan sonra saat başı çalıştırın:
-- select cron.schedule('purge-listings', '0 * * * *', 'select public.purge_expired_listings()');
