// supabase/functions/notify-moderator/index.ts
//
// Вызывается Database Webhook'ом Supabase при INSERT в
// public.roommate_applications (настраивается в Dashboard → Database →
// Webhooks, см. README.md → "Настройка уведомлений модератору").
//
// Берёт данные новой анкеты, форматирует их в читаемый текст и через
// Telegram Bot API шлёт модератору(ам) сообщение с фото анкеты и двумя
// кнопками: "✅ Принять" / "❌ Отклонить". Нажатие кнопок обрабатывает
// соседняя функция telegram-webhook.
//
// Переменные окружения (Project Settings → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN  — токен бота от @BotFather
//   MODERATOR_CHAT_IDS  — id чата(ов) модератора(ов) через запятую
//                         (свой numeric id можно узнать у @userinfobot)
//   WEBHOOK_SECRET      — произвольная строка; должна совпадать со
//                         значением заголовка x-webhook-secret, который
//                         настроен в Database Webhook
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — прокидываются платформой
//                         автоматически, вручную задавать не нужно

import { createClient } from 'jsr:@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const MODERATOR_CHAT_IDS = (Deno.env.get('MODERATOR_CHAT_IDS') ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? ''

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

const HOUSING_LABELS: Record<string, string> = { dorm: 'Общежитие', apartment: 'Съёмная квартира' }
const SMOKING_LABELS: Record<string, string> = { yes: 'Да', no: 'Нет', sometimes: 'Иногда' }
const SLEEP_LABELS: Record<string, string> = { owl: 'Сова', lark: 'Жаворонок' }
const GUESTS_LABELS: Record<string, string> = { often: 'Часто', rarely: 'Редко', never: 'Никогда' }
const CLEAN_LABELS: Record<string, string> = { important: 'Важна', not_important: 'Не принципиальна' }

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Собирает подпись к фото анкеты. Telegram ограничивает caption 1024
// символами — обрезаем с запасом, если анкета получилась длинной.
function formatCaption(record: Record<string, any>): string {
  const lines: string[] = []
  lines.push('<b>Новая анкета сожителя</b>', '')
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
  if (record.instagram) extras.push(`📷 ${escapeHtml(record.instagram)}`)
  if (record.vk) extras.push(`VK: ${escapeHtml(record.vk)}`)
  if (record.whatsapp) extras.push(`WhatsApp: ${escapeHtml(record.whatsapp)}`)
  if (extras.length) lines.push('', ...extras)

  if (record.about) lines.push('', `💬 ${escapeHtml(record.about)}`)
  if (record.telegram_username) lines.push('', `Отправитель: @${escapeHtml(record.telegram_username)}`)

  const caption = lines.join('\n')
  return caption.length > 1024 ? caption.slice(0, 1021) + '…' : caption
}

async function callTelegram(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!data.ok) console.error(`Telegram ${method} failed:`, data)
  return data
}

Deno.serve(async (req) => {
  // Простая проверка, что запрос пришёл от нашего Database Webhook,
  // а не от кого попало, кто угадал URL функции.
  if (WEBHOOK_SECRET && req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }
  if (!TELEGRAM_BOT_TOKEN || MODERATOR_CHAT_IDS.length === 0) {
    console.error('TELEGRAM_BOT_TOKEN / MODERATOR_CHAT_IDS не заданы в секретах функции')
    return new Response('Not configured', { status: 500 })
  }

  const payload = await req.json().catch(() => null)
  // Database Webhook присылает { type: 'INSERT', table, record, ... }
  const record = payload?.record ?? payload
  if (!record?.id) {
    return new Response('Bad payload', { status: 400 })
  }

  const caption = formatCaption(record)
  const photoUrls: string[] = record.photo_urls ?? []
  const [firstPhoto, ...restPhotos] = photoUrls

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Принять', callback_data: `approve:${record.id}` },
      { text: '❌ Отклонить', callback_data: `reject:${record.id}` },
    ]],
  }

  const refs: { chat_id: number; message_id: number }[] = []

  for (const chatId of MODERATOR_CHAT_IDS) {
    const result = firstPhoto
      ? await callTelegram('sendPhoto', {
          chat_id: chatId,
          photo: firstPhoto,
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
      : await callTelegram('sendMessage', {
          chat_id: chatId,
          text: caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })

    if (result.ok) {
      refs.push({ chat_id: result.result.chat.id, message_id: result.result.message_id })
    } else {
      console.error(`Не удалось отправить анкету ${record.id} модератору ${chatId}`)
    }

    // Остальные фото — отдельными сообщениями без кнопок сразу следом,
    // чтобы не упираться в лимит caption и не плодить кнопки на каждом фото.
    for (const url of restPhotos) {
      await callTelegram('sendPhoto', { chat_id: chatId, photo: url })
    }
  }

  // Запоминаем, какие сообщения отправили — telegram-webhook использует
  // это, чтобы после решения модератора снять кнопки везде.
  const { error } = await supabase
    .from('roommate_applications')
    .update({ moderation_messages: refs })
    .eq('id', record.id)

  if (error) console.error('Не удалось сохранить moderation_messages:', error)

  return new Response(JSON.stringify({ ok: true, sent: refs.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
