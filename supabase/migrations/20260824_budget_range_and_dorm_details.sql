-- ============================================================
-- Миграция: диапазон бюджета "от/до" + расширенное описание поля
-- общежития (корпус/номер + направление + способ поступления).
--
-- Применяется к уже существующей таблице roommate_applications
-- (созданной по старой версии supabase/schema.sql, где budget был
-- одним select-полем с фиксированными диапазонами).
-- ============================================================

alter table public.roommate_applications
  drop constraint if exists housing_details_present,
  drop constraint if exists roommate_applications_budget_check;

alter table public.roommate_applications
  drop column if exists budget;

alter table public.roommate_applications
  add column if not exists budget_from integer,
  add column if not exists budget_to integer;

alter table public.roommate_applications
  add constraint budget_range_check check (budget_to is null or budget_to >= budget_from);

alter table public.roommate_applications
  add constraint housing_details_present check (
    (housing_type = 'dorm' and dorm_building is not null and char_length(trim(dorm_building)) > 0)
    or
    (housing_type = 'apartment' and budget_from is not null and budget_to is not null)
  );

alter table public.roommate_applications
  add constraint budget_from_check check (budget_from is null or budget_from >= 0);

comment on column public.roommate_applications.dorm_building is
  'Корпус/номер общежития, направление подготовки и способ поступления (одной строкой)';
