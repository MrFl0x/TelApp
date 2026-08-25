// supabase/functions/_shared/format-application.ts
//
// Общее форматирование анкеты в HTML-текст для Telegram — используется и
// notify-moderator (сообщение модератору), и telegram-webhook (пост в
// канал после «Принять»).

export const HOUSING_LABELS: Record<string, string> = { dorm: 'Общежитие', apartment: 'Съёмная квартира' }
export const SMOKING_LABELS: Record<string, string> = { yes: 'Да', no: 'Нет', sometimes: 'Иногда' }
export const SLEEP_LABELS: Record<string, string> = { owl: 'Сова', lark: 'Жаворонок' }
export const GUESTS_LABELS: Record<string, string> = { often: 'Часто', rarely: 'Редко', never: 'Никогда' }
export const CLEAN_LABELS: Record<string, string> = { important: 'Важна', not_important: 'Не принципиальна' }

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// title — например, "Новая анкета сожителя" (для модератора) или
// "🎉 Ищет сожителя" (для канала). Передайте '' чтобы не выводить заголовок.
// includeSubmitter — показывать ли telegram_username отправителя (нужно
// модератору для контекста, но не нужно в публичном канале).
export function formatApplicationCaption(
  record: Record<string, any>,
  title: string,
  { includeSubmitter = true }: { includeSubmitter?: boolean } = {},
): string {
  const lines: string[] = []
  if (title) lines.push(`<b>${escapeHtml(title)}</b>`, '')

  lines.push(`👤 <b>${escapeHtml(record.name)}</b>, ${record.age ?? '—'} лет`)
  lines.push(`🏠 ${HOUSING_LABELS[record.housing_type] ?? record.housing_type}`)
  if (record.housing_type === 'dorm' && record.dorm_building) {
    lines.push(`   ${escapeHtml(record.dorm_building)}`)
  }
  if (record.housing_type === 'apartment') {
    lines.push(`   Бюджет: ${record.budget_from ?? '?'}–${record.budget_to ?? '?'} ₽`)
  }
  lines.push(`✉️ Контакт: ${escapeHtml(record.contact)}`, '')
  lines.push(`🚬 Курение: ${SMOKING_LABELS[record.smoking] ?? record.smoking}`)
  lines.push(`🌙 Режим сна: ${SLEEP_LABELS[record.sleep_schedule] ?? record.sleep_schedule}`)
  lines.push(`🙋 Гости: ${GUESTS_LABELS[record.guests] ?? record.guests}`)
  lines.push(`🧹 Чистота: ${CLEAN_LABELS[record.cleanliness] ?? record.cleanliness}`)

  const extras: string[] = []
  if (record.phone) extras.push(`📞 ${escapeHtml(record.phone)}`)
  // <code> — иначе Telegram сам подсвечивает "@ник" как упоминание
  // Telegram-пользователя, хотя это инстаграм-ник, а не тг-юзернейм.
  if (record.instagram) extras.push(`📷 Instagram: <code>${escapeHtml(record.instagram)}</code>`)
  if (record.vk) extras.push(`VK: ${escapeHtml(record.vk)}`)
  if (record.whatsapp) extras.push(`WhatsApp: ${escapeHtml(record.whatsapp)}`)
  if (extras.length) lines.push('', ...extras)

  if (record.about) lines.push('', `💬 ${escapeHtml(record.about)}`)
  if (includeSubmitter && record.telegram_username) {
    lines.push('', `Отправитель: @${escapeHtml(record.telegram_username)}`)
  }

  const caption = lines.join('\n')
  // Telegram caption limit — 1024 символа
  return caption.length > 1024 ? caption.slice(0, 1021) + '…' : caption
}
