-- ============================================================
-- Схема для Telegram Mini App "Анкета сожителя"
-- Выполнить в Supabase SQL Editor (или через `supabase db push`).
-- Скрипт идемпотентный — его можно безопасно запускать повторно.
-- ============================================================

-- pgcrypto нужен для gen_random_uuid(); на большинстве проектов Supabase
-- уже включён, "if not exists" на всякий случай.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- 1. Таблица анкет
-- ---------------------------------------------------------------
create table if not exists public.roommate_applications (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),

  -- Общие поля
  name               text not null check (char_length(trim(name)) > 0),
  age                smallint check (age between 16 and 99),
  housing_type       text not null check (housing_type in ('dorm', 'apartment')),
  -- Для общежития — одной строкой: корпус/номер общежития, направление
  -- подготовки и способ поступления (бюджет/платно)
  dorm_building      text,
  -- Для съёмной квартиры — диапазон бюджета "от"/"до" в рублях
  budget_from        integer check (budget_from >= 0),
  budget_to          integer,
  contact            text not null check (char_length(trim(contact)) > 0),

  -- Образ жизни
  smoking            text not null check (smoking in ('yes', 'no', 'sometimes')),
  sleep_schedule     text not null check (sleep_schedule in ('owl', 'lark')),
  guests             text not null check (guests in ('often', 'rarely', 'never')),
  cleanliness        text not null check (cleanliness in ('important', 'not_important')),

  -- Фотографии: сами файлы лежат в Storage-бакете `roommate-photos`,
  -- здесь храним только их публичные URL (от 1 до 3 штук).
  photo_urls         text[] not null default '{}',

  -- Дополнительные (необязательные) поля
  phone              text,
  instagram          text,
  vk                 text,
  whatsapp           text,
  about              text check (char_length(about) <= 300),

  -- Данные из Telegram WebApp initData — помогают понять, кто именно
  -- отправил анкету (в отличие от поля "contact", их не подделать через форму)
  telegram_user_id   bigint,
  telegram_username  text,

  -- Условно обязательные поля в зависимости от типа жилья
  constraint housing_details_present check (
    (housing_type = 'dorm' and dorm_building is not null and char_length(trim(dorm_building)) > 0)
    or
    (housing_type = 'apartment' and budget_from is not null and budget_to is not null)
  ),

  -- "От" не больше, чем "до"
  constraint budget_range_check check (budget_to is null or budget_to >= budget_from),

  -- От 1 до 3 фото
  constraint photo_count_range check (cardinality(photo_urls) between 1 and 3)
);

comment on table public.roommate_applications is 'Анкеты из Telegram Mini App "Анкета сожителя"';
comment on column public.roommate_applications.dorm_building is
  'Корпус/номер общежития, направление подготовки и способ поступления (одной строкой)';

create index if not exists roommate_applications_created_at_idx
  on public.roommate_applications (created_at desc);
create index if not exists roommate_applications_housing_type_idx
  on public.roommate_applications (housing_type);
create index if not exists roommate_applications_telegram_user_id_idx
  on public.roommate_applications (telegram_user_id);

-- ---------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------
-- Мини-апп обращается к Supabase анонимным (anon) ключом прямо из
-- браузера пользователя, поэтому без RLS кто угодно смог бы читать
-- или менять чужие анкеты. Разрешаем анониму только добавлять новые
-- записи — читать (например, для экрана "смотреть анкеты других")
-- пока нельзя никому, кроме service_role.
alter table public.roommate_applications enable row level security;

create policy "Anyone can submit an application"
  on public.roommate_applications
  for insert
  to anon
  with check (true);

-- Когда понадобится публичный список анкет — добавьте что-то вроде:
-- create policy "Anyone can view applications"
--   on public.roommate_applications for select to anon using (true);

-- ---------------------------------------------------------------
-- 3. Storage-бакет для фотографий
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'roommate-photos',
  'roommate-photos',
  true,                                 -- фото должны открываться у всех (превью анкет)
  5242880,                              -- 5 МБ — совпадает с лимитом на фронтенде
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

create policy "Public read access to roommate photos"
  on storage.objects for select
  to public
  using (bucket_id = 'roommate-photos');

create policy "Anyone can upload roommate photos"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'roommate-photos');
