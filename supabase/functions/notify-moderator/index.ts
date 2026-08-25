// supabase/functions/notify-moderator/index.ts
//
// Вызывается Database Webhook'ом Supabase при INSERT в
// public.roommate_applications (настраивается в Dashboard → Database →
// Webhooks, см. README.md → "Настройка уведомлений модератору").
//
// Берёт данные новой анкеты, форматирует их в читаемый текст и через
// Telegram Bot API шлёт модератору(ам) фото анкеты (одно — с подписью и
// кнопками; несколько — альбомом с подписью на первом фото и кнопками в
// отдельном сообщении сразу под альбомом, т.к. Telegram не разрешает
// прикреплять кнопки к элементам альбома). Кнопки "✅ Принять" /
// "❌ Отклонить" обрабатывает соседняя функция telegram-webhook.
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
import { formatApplicationCaption } from '../_shared/format-application.ts'

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

  const caption = formatApplicationCaption(record, 'Новая анкета сожителя')
  const photoUrls: string[] = record.photo_urls ?? []

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Принять', callback_data: `approve:${record.id}` },
      { text: '❌ Отклонить', callback_data: `reject:${record.id}` },
    ]],
  }

  const refs: { chat_id: number; message_id: number }[] = []

  for (const chatId of MODERATOR_CHAT_IDS) {
    if (photoUrls.length <= 1) {
      // Без фото или с одним фото — кнопки вешаем прямо на это сообщение.
      const result = photoUrls.length === 1
        ? await callTelegram('sendPhoto', {
            chat_id: chatId,
            photo: photoUrls[0],
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
      continue
    }

    // Несколько фото — одним альбомом (подпись на первом), а кнопки —
    // отдельным сообщением сразу за ним (Telegram не позволяет reply_markup
    // на элементах sendMediaGroup), с reply_to_message_id на альбом, чтобы
    // было видно, к какой анкете относятся кнопки.
    const albumResult = await callTelegram('sendMediaGroup', {
      chat_id: chatId,
      media: photoUrls.map((url, i) => ({
        type: 'photo',
        media: url,
        ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
      })),
    })

    if (!albumResult.ok) {
      console.error(`Не удалось отправить альбом анкеты ${record.id} модератору ${chatId}`)
      continue
    }

    const albumFirstMessageId = albumResult.result?.[0]?.message_id
    const buttonsResult = await callTelegram('sendMessage', {
      chat_id: chatId,
      text: '👆 Решение по анкете выше',
      ...(albumFirstMessageId ? { reply_to_message_id: albumFirstMessageId } : {}),
      reply_markup: keyboard,
    })

    if (buttonsResult.ok) {
      refs.push({ chat_id: buttonsResult.result.chat.id, message_id: buttonsResult.result.message_id })
    } else {
      console.error(`Не удалось отправить кнопки анкеты ${record.id} модератору ${chatId}`)
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
