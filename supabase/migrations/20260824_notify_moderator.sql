-- ============================================================
-- Миграция: модерация анкет через Telegram.
--
-- Добавляет статус анкеты и служебные поля, которые заполняют
-- Edge Functions `notify-moderator` и `telegram-webhook`
-- (см. supabase/functions/). Применяется к уже существующей таблице
-- roommate_applications.
-- ============================================================

alter table public.roommate_applications
  add column if not exists status text not null default 'pending',
  add column if not exists moderated_at timestamptz,
  add column if not exists moderated_by bigint,
  -- Список сообщений, отправленных модератору(ам) в Telegram по этой
  -- анкете: [{ "chat_id": ..., "message_id": ... }, ...]. Нужен, чтобы
  -- после решения модератора снять кнопки "Принять/Отклонить" с сообщений
  -- у всех, кому анкету показывали.
  add column if not exists moderation_messages jsonb not null default '[]';

alter table public.roommate_applications
  drop constraint if exists roommate_applications_status_check;

alter table public.roommate_applications
  add constraint roommate_applications_status_check
    check (status in ('pending', 'approved', 'rejected'));

create index if not exists roommate_applications_status_idx
  on public.roommate_applications (status);

comment on column public.roommate_applications.status is
  'pending — ждёт модерации, approved/rejected — решение принято в Telegram';
comment on column public.roommate_applications.moderated_by is
  'Telegram user id модератора, нажавшего кнопку Принять/Отклонить';
comment on column public.roommate_applications.moderation_messages is
  'Сообщения в Telegram-чатах модераторов с этой анкетой (для снятия кнопок после решения)';

-- ---------------------------------------------------------------
-- Автоматический вызов notify-moderator при новой анкете.
-- ---------------------------------------------------------------
-- Supabase-хостинг создаёт схему `supabase_functions` со вспомогательной
-- функцией http_request() автоматически — её и используют Database
-- Webhooks, настроенные через Dashboard (Database → Webhooks). Проще
-- всего создать этот webhook именно там (см. README.md → "Настройка
-- уведомлений модератору"), а не через SQL: URL функции и секретный
-- заголовок туда лучше не коммитить.
--
-- Если всё же нужен воспроизводимый SQL-триггер — раскомментируйте и
-- подставьте свои значения:
--
-- create trigger on_roommate_application_insert
--   after insert on public.roommate_applications
--   for each row execute function supabase_functions.http_request(
--     'https://<project-ref>.functions.supabase.co/notify-moderator',
--     'POST',
--     '{"Content-Type":"application/json","x-webhook-secret":"<тот же WEBHOOK_SECRET, что в секретах функции>"}',
--     '{}',
--     '5000'
--   );
