-- KolaySu su yükleme şeması (PostgreSQL / Supabase).
-- YALNIZCA YENİ TABLOLAR oluşturur; mevcut sitenin hiçbir tablosunu değiştirmez veya silmez.
-- Ad çakışmasını önlemek için tüm nesneler ayrı "water_topup" şemasındadır.
-- Canlı veritabanına uygulanmadan önce onay alınmalıdır (bkz. docs/security-plan.md).

create schema if not exists water_topup;

-- 1) Abonelikler (sayaçlar)
create table if not exists water_topup.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  utility_code  text not null check (utility_code ~ '^[a-z0-9-]{2,40}$'),
  subscriber_no text not null check (subscriber_no ~ '^\d{4,20}$'),
  meter_no      text not null check (meter_no ~ '^\d{4,20}$'),
  meter_type    text not null check (meter_type in ('card','smart')),
  status        text not null default 'pending' check (status in ('pending','verified','rejected','archived')),
  verified_at   timestamptz,
  created_at    timestamptz not null default now()
);
create unique index if not exists subscriptions_active_uq
  on water_topup.subscriptions (user_id, utility_code, subscriber_no, meter_no) where status <> 'archived';

-- 2) NFC kart eşleştirmeleri. Açık UID SAKLANMAZ; yalnızca sunucu anahtarlı HMAC.
create table if not exists water_topup.card_bindings (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references water_topup.subscriptions(id),
  user_id         uuid not null,
  uid_hash        text not null check (uid_hash ~ '^[0-9a-f]{64}$'),
  tech_summary    text,
  status          text not null default 'pending' check (status in ('pending','verified','revoked')),
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
-- Bir kart aynı anda yalnızca bir aktif eşleştirmeye sahip olabilir.
create unique index if not exists card_bindings_uid_active_uq on water_topup.card_bindings (uid_hash) where status <> 'revoked';

-- 3) Tarifeler
create table if not exists water_topup.tariffs (
  utility_code     text primary key,
  unit_price_kurus integer not null check (unit_price_kurus > 0),
  min_m3           numeric(8,2) not null check (min_m3 > 0),
  max_m3           numeric(8,2) not null check (max_m3 >= min_m3),
  fee_rate         numeric(5,4) not null default 0 check (fee_rate between 0 and 0.2),
  updated_at       timestamptz not null default now()
);

-- 4) Yükleme siparişleri
create table if not exists water_topup.topup_orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         text not null unique check (order_no ~ '^SK[0-9A-F]{20}$'),
  user_id          uuid not null,
  subscription_id  uuid not null references water_topup.subscriptions(id),
  mode             text not null check (mode in ('sandbox','live')),
  m3               numeric(8,2) not null check (m3 > 0),
  water_kurus      integer not null check (water_kurus > 0),
  fee_kurus        integer not null check (fee_kurus >= 0),
  total_kurus      integer not null check (total_kurus = water_kurus + fee_kurus),
  paid_kurus       integer,
  status           text not null default 'created' check (status in
                     ('created','awaiting_payment','payment_failed','expired','paid','utility_pending',
                      'utility_failed','completed','refund_pending','refunded')),
  utility_ref      text,
  utility_attempts integer not null default 0,
  next_retry_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (status <> 'completed' or utility_ref is not null)
);
create index if not exists topup_orders_user_idx on water_topup.topup_orders (user_id, created_at desc);
-- Aynı abonelik için aynı anda tek ödenmemiş sipariş (çift tıklama koruması).
create unique index if not exists topup_orders_one_open_uq
  on water_topup.topup_orders (subscription_id) where status in ('created','awaiting_payment');

-- 5) Ödeme bildirimleri (ödeme kuruluşu tekrar gönderse de bir kez işlenir)
create table if not exists water_topup.payment_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references water_topup.topup_orders(id),
  provider     text not null,
  provider_ref text not null,
  status       text not null check (status in ('success','failed')),
  paid_kurus   integer not null,
  verified     boolean not null,
  received_at  timestamptz not null default now(),
  unique (provider, provider_ref, status)
);

-- 6) Sipariş durum geçmişi (yalnızca ekleme)
create table if not exists water_topup.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references water_topup.topup_orders(id),
  from_status text not null,
  to_status   text not null,
  note        text,
  at          timestamptz not null default now()
);

-- 7) Kart işlemleri. Sipariş başına en fazla bir başarısız olmayan işlem.
create table if not exists water_topup.card_operations (
  id              uuid primary key default gen_random_uuid(),
  op_no           text not null unique check (op_no ~ '^KK\d{6}[0-9A-F]{12}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^[0-9a-f]{64}$'),
  order_id        uuid not null references water_topup.topup_orders(id),
  binding_id      uuid not null references water_topup.card_bindings(id),
  mode            text not null check (mode in ('simulated','live')),
  status          text not null check (status in ('requested','payment_verified','simulated','pending_device','completed','failed')),
  result_ref      text,
  created_at      timestamptz not null default now()
);
create unique index if not exists card_operations_one_per_order_uq on water_topup.card_operations (order_id) where status <> 'failed';

-- Durum geçiş kuralları veritabanında da zorlanır (servisteki ORDER_TRANSITIONS ile aynı).
create or replace function water_topup.guard_order_transition() returns trigger language plpgsql as $$
declare ok boolean;
begin
  if new.order_no <> old.order_no or new.total_kurus <> old.total_kurus or new.water_kurus <> old.water_kurus or new.fee_kurus <> old.fee_kurus or new.user_id <> old.user_id or new.subscription_id <> old.subscription_id or new.mode <> old.mode then
    raise exception 'Sipariş numarası, tutar ve mod değiştirilemez';
  end if;
  if new.status = old.status then new.updated_at := now(); return new; end if;
  ok := (old.status, new.status) in (
    ('created','awaiting_payment'), ('created','expired'),
    ('awaiting_payment','paid'), ('awaiting_payment','payment_failed'), ('awaiting_payment','expired'), ('awaiting_payment','refund_pending'),
    ('paid','utility_pending'),
    ('utility_pending','completed'), ('utility_pending','utility_failed'),
    ('utility_failed','utility_pending'), ('utility_failed','completed'), ('utility_failed','refund_pending'),
    ('refund_pending','refunded'));
  if not ok then raise exception 'Geçersiz sipariş durumu geçişi: % -> %', old.status, new.status; end if;
  insert into water_topup.order_events(order_id, from_status, to_status) values (new.id, old.status, new.status);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists topup_orders_guard on water_topup.topup_orders;
create trigger topup_orders_guard before update on water_topup.topup_orders
  for each row execute function water_topup.guard_order_transition();

-- Canlı kart işlemi, yetkili SDK devreye alınana kadar veritabanında da engellenir.
create or replace function water_topup.block_live_card_ops() returns trigger language plpgsql as $$
begin
  if new.mode = 'live' then raise exception 'Gerçek karta yazma kapalı: yetkili SDK tanımlı değil'; end if;
  return new;
end $$;
drop trigger if exists card_operations_block_live on water_topup.card_operations;
create trigger card_operations_block_live before insert or update on water_topup.card_operations
  for each row execute function water_topup.block_live_card_ops();

-- RLS: kullanıcı yalnızca kendi kayıtlarını okur; yazma yalnızca sunucu (service_role) üzerinden.
alter table water_topup.subscriptions   enable row level security;
alter table water_topup.card_bindings   enable row level security;
alter table water_topup.topup_orders    enable row level security;
alter table water_topup.payment_events  enable row level security;
alter table water_topup.order_events    enable row level security;
alter table water_topup.card_operations enable row level security;
alter table water_topup.tariffs         enable row level security;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create policy own_subs on water_topup.subscriptions for select to authenticated using (user_id = auth.uid())';
    execute 'create policy own_bindings on water_topup.card_bindings for select to authenticated using (user_id = auth.uid())';
    execute 'create policy own_orders on water_topup.topup_orders for select to authenticated using (user_id = auth.uid())';
    execute 'create policy own_ops on water_topup.card_operations for select to authenticated using (exists (select 1 from water_topup.topup_orders o where o.id = order_id and o.user_id = auth.uid()))';
    execute 'create policy read_tariffs on water_topup.tariffs for select to authenticated using (true)';
  end if;
exception when duplicate_object then null;
end $$;
