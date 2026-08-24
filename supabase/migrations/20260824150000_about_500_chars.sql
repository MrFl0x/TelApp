-- ============================================================
-- Миграция: увеличение лимита поля "О себе" с 300 до 500 символов.
-- ============================================================

alter table public.roommate_applications
  drop constraint if exists roommate_applications_about_check;

alter table public.roommate_applications
  add constraint roommate_applications_about_check check (char_length(about) <= 500);
