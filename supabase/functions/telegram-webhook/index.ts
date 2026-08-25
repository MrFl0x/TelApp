// supabase/functions/telegram-webhook/index.ts
//
// Принимает апдейты от Telegram (после `setWebhook`, см. README.md →
// "Настройка уведомлений модератору"). Обрабатывает нажатия на кнопки
// "✅ Принять" / "❌ Отклонить" под анкетой в чате модератора: обновляет
// статус анкеты в БД и убирает кнопки из всех сообщений с этой анкетой.
//
// Анкеты, принятые модератором ("✅ Принять"), дополнительно публикуются в
// Telegram-каналы (CHANNEL_CHAT_IDS) — с фото и той же подписью, без кнопок.
//
// Также обрабатывает команду /start в личке с ботом: шлёт короткое
// приветствие с кнопкой, открывающей Mini App (MINI_APP_URL).
//
// Переменные окружения:
//   TELEGRAM_BOT_TOKEN      — токен бота
//   TELEGRAM_WEBHOOK_SECRET — секрет, который Telegram присылает в
//                             заголовке X-Telegram-Bot-Api-Secret-Token
//                             (задаётся параметром secret_token в setWebhook)
//   CHANNEL_CHAT_ID(S)      — id канала(ов), куда публиковать принятые
//                             анкеты, через запятую; numeric id или
//                             @username публичного канала (бот должен быть
//                             там админом с правом постить сообщения); если
//                             не задан — публикация в каналы пропускается,
//                             статус всё равно пишется
//   MINI_APP_URL            — ссылка на Mini App для кнопки в /start
//                             (по умолчанию — GitHub Pages этого репозитория)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — прокидываются платформой
//                             автоматически, вручную задавать не нужно

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { formatApplicationCaption } from '../_shared/format-application.ts'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''
// Поддерживаем и CHANNEL_CHAT_ID (старое имя, один канал), и CHANNEL_CHAT_IDS
// (новое имя, несколько каналов через запятую) — чтобы не ломать настройку
// у тех, кто уже задал секрет под старым именем.
const CHANNEL_CHAT_IDS = (
  Deno.env.get('CHANNEL_CHAT_IDS') ??
  Deno.env.get('CHANNEL_CHAT_ID') ??
  ''
)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const MINI_APP_URL = Deno.env.get('MINI_APP_URL') || 'https://mrfl0x.github.io/TelApp/'

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

// Публикует принятую анкету во все настроенные каналы: одно фото с
// подписью, либо несколько фото альбомом (подпись — на первом). Не выводим
// кнопки и не упоминаем, кто именно из модераторов принял анкету — это уже
// не нужно читателям канала.
async function postToChannel(record: Record<string, any>) {
  if (CHANNEL_CHAT_IDS.length === 0) return
  const caption = formatApplicationCaption(record, '', { includeSubmitter: false })
  const photoUrls: string[] = record.photo_urls ?? []

  for (const chatId of CHANNEL_CHAT_IDS) {
    if (photoUrls.length === 0) {
      await callTelegram('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' })
    } else if (photoUrls.length === 1) {
      await callTelegram('sendPhoto', {
        chat_id: chatId,
        photo: photoUrls[0],
        caption,
        parse_mode: 'HTML',
      })
    } else {
      await callTelegram('sendMediaGroup', {
        chat_id: chatId,
        media: photoUrls.map((url, i) => ({
          type: 'photo',
          media: url,
          ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
        })),
      })
    }
  }
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
    // Не нажатие кнопки. Отдельно обрабатываем /start и /id — остальное
    // (обычные сообщения боту) просто подтверждаем 200, иначе Telegram
    // будет повторять апдейт.
    const messageText: string = update?.message?.text ?? ''
    const command = messageText.split(' ')[0].split('@')[0]
    const chatId = update?.message?.chat?.id

    if (command === '/start' && chatId) {
      // Показываем chat id прямо в приветствии — это тот самый id, который
      // нужно давать в MODERATOR_CHAT_IDS, чтобы не искать его отдельно
      // через @userinfobot.
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text:
          '👋 Привет! Это бот для поиска сожителей РАНХиГС.\n\n' +
          'Заполни анкету — она откроется прямо в Telegram, займёт пару минут. ' +
          'Нажми кнопку ниже, чтобы начать.\n\n' +
          `Твой Telegram id: <code>${chatId}</code>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Открыть', web_app: { url: MINI_APP_URL } }]],
        },
      })
    } else if (command === '/id' && chatId) {
      // Быстрый способ узнать/напомнить свой chat id, без всего остального
      // текста из /start.
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: `Твой Telegram id: <code>${chatId}</code>`,
        parse_mode: 'HTML',
      })
    }
    return new Response('ok')
  }

  const [action, applicationId] = String(callback.data ?? '').split(':')
  if ((action !== 'approve' && action !== 'reject') || !applicationId) {
    await callTelegram('answerCallbackQuery', { callback_query_id: callback.id })
    return new Response('ok')
  }

  // select('*') — при "Принять" нужны все поля анкеты, чтобы собрать пост в канал.
  const { data: application, error: fetchError } = await supabase
    .from('roommate_applications')
    .select('*')
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

  if (status === 'approved') {
    await postToChannel(application)
  }

  const clickedChatId = callback.message?.chat?.id
  const clickedMessageId = callback.message?.message_id
  const refs: { chat_id: number; message_id: number }[] = application.moderation_messages?.length
    ? application.moderation_messages
    : [{ chat_id: clickedChatId, message_id: clickedMessageId }]

  const confirmationText =
    status === 'approved' && CHANNEL_CHAT_IDS.length > 0
      ? `${statusLabel} — ${moderatorName}\nОпубликована в канале ✅`
      : `${statusLabel} — ${moderatorName}`

  for (const ref of refs) {
    // Снимаем кнопки со всех сообщений с этой анкетой, у всех модераторов.
    // Каждый вызов — по отдельности и без выброса исключений, чтобы сбой
    // одного шага (например, edit при не изменившемся тексте) не мешал
    // остальным и модератор в любом случае получил явное сообщение ниже.
    await callTelegram('editMessageReplyMarkup', {
      chat_id: ref.chat_id,
      message_id: ref.message_id,
      reply_markup: { inline_keyboard: [] },
    })

    if (ref.chat_id === clickedChatId && ref.message_id === clickedMessageId) {
      // В сообщении, где нажали кнопку, есть исходная подпись — дописываем
      // в неё итог решения (best-effort: если Telegram откажет — не страшно,
      // ниже всё равно уйдёт отдельное сообщение-подтверждение).
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
    }

    // Явное сообщение-подтверждение решения — отдельно от edit'а выше,
    // чтобы модератор точно увидел ответ, даже если caption не поменялся
    // или его не было (текстовое сообщение без фото).
    await callTelegram('sendMessage', {
      chat_id: ref.chat_id,
      reply_to_message_id: ref.message_id,
      text: confirmationText,
    })
  }

  await callTelegram('answerCallbackQuery', {
    callback_query_id: callback.id,
    text: statusLabel,
  })

  return new Response('ok')
})
