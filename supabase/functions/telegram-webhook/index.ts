// supabase/functions/telegram-webhook/index.ts
//
// Принимает апдейты от Telegram (после `setWebhook`, см. README.md →
// "Настройка уведомлений модератору"). Обрабатывает нажатия на кнопки
// "✅ Принять" / "❌ Отклонить" под анкетой в чате модератора: обновляет
// статус анкеты в БД и убирает кнопки из всех сообщений с этой анкетой.
//
// Переменные окружения:
//   TELEGRAM_BOT_TOKEN      — токен бота
//   TELEGRAM_WEBHOOK_SECRET — секрет, который Telegram присылает в
//                             заголовке X-Telegram-Bot-Api-Secret-Token
//                             (задаётся параметром secret_token в setWebhook)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — прокидываются платформой
//                             автоматически, вручную задавать не нужно

import { createClient } from 'jsr:@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
  if (
    TELEGRAM_WEBHOOK_SECRET &&
    req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response('Unauthorized', { status: 401 })
  }

  const update = await req.json().catch(() => null)
  const callback = update?.callback_query
  if (!callback) {
    // Не нажатие кнопки (например, обычное сообщение боту) — просто ок,
    // Telegram ждёт 200, иначе будет повторять апдейт.
    return new Response('ok')
  }

  const [action, applicationId] = String(callback.data ?? '').split(':')
  if ((action !== 'approve' && action !== 'reject') || !applicationId) {
    await callTelegram('answerCallbackQuery', { callback_query_id: callback.id })
    return new Response('ok')
  }

  const { data: application, error: fetchError } = await supabase
    .from('roommate_applications')
    .select('status, moderation_messages')
    .eq('id', applicationId)
    .single()

  if (fetchError || !application) {
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Анкета не найдена',
      show_alert: true,
    })
    return new Response('ok')
  }

  if (application.status !== 'pending') {
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Анкета уже обработана',
    })
    return new Response('ok')
  }

  const status = action === 'approve' ? 'approved' : 'rejected'
  const moderatorId: number | null = callback.from?.id ?? null
  const moderatorName =
    [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(' ') ||
    (callback.from?.username ? `@${callback.from.username}` : 'модератор')
  const statusLabel = status === 'approved' ? '✅ Принята' : '❌ Отклонена'

  const { error: updateError } = await supabase
    .from('roommate_applications')
    .update({ status, moderated_at: new Date().toISOString(), moderated_by: moderatorId })
    .eq('id', applicationId)

  if (updateError) {
    console.error('Не удалось обновить статус анкеты:', updateError)
    await callTelegram('answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Ошибка сохранения, попробуйте ещё раз',
      show_alert: true,
    })
    return new Response('ok')
  }

  const clickedChatId = callback.message?.chat?.id
  const clickedMessageId = callback.message?.message_id
  const refs: { chat_id: number; message_id: number }[] = application.moderation_messages?.length
    ? application.moderation_messages
    : [{ chat_id: clickedChatId, message_id: clickedMessageId }]

  for (const ref of refs) {
    // Снимаем кнопки со всех сообщений с этой анкетой, у всех модераторов.
    await callTelegram('editMessageReplyMarkup', {
      chat_id: ref.chat_id,
      message_id: ref.message_id,
      reply_markup: { inline_keyboard: [] },
    })

    if (ref.chat_id === clickedChatId && ref.message_id === clickedMessageId) {
      // В сообщении, где нажали кнопку, есть исходная подпись — дописываем
      // в неё итог решения.
      const original = callback.message?.caption ?? callback.message?.text ?? ''
      const updatedText = `${original}\n\n${statusLabel} — ${escapeHtml(moderatorName)}`
      const method = callback.message?.caption !== undefined ? 'editMessageCaption' : 'editMessageText'
      const textField = callback.message?.caption !== undefined ? 'caption' : 'text'
      await callTelegram(method, {
        chat_id: ref.chat_id,
        message_id: ref.message_id,
        [textField]: updatedText,
        parse_mode: 'HTML',
      })
    } else {
      // У остальных модераторов исходного текста под рукой нет — просто
      // сообщаем решение отдельным сообщением-ответом.
      await callTelegram('sendMessage', {
        chat_id: ref.chat_id,
        reply_to_message_id: ref.message_id,
        text: `${statusLabel} — ${moderatorName}`,
      })
    }
  }

  await callTelegram('answerCallbackQuery', {
    callback_query_id: callback.id,
    text: statusLabel,
  })

  return new Response('ok')
})
