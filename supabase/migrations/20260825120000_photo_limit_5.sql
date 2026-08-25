-- ============================================================
-- Миграция: увеличение лимита фото в анкете с 3 до 5 штук.
-- ============================================================

alter table public.roommate_applications
  drop constraint if exists photo_count_range;

alter table public.roommate_applications
  add constraint photo_count_range check (cardinality(photo_urls) between 1 and 5);
