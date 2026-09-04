import type { AppSettings } from "@shared/types";

export function telegramConfigured(s: AppSettings): boolean {
  return !!(s.telegramBotToken && s.telegramChatId);
}

export function escapeHtml(t: string): string {
  return t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/** Send an HTML-formatted message to the admin's Telegram chat. */
export async function sendTelegram(s: AppSettings, html: string, chatId = s.telegramChatId): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** Find chats that recently messaged the bot (so the admin can pick their chat id). */
export async function telegramRecentChats(token: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`);
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  const data = (await res.json()) as { result?: { message?: { chat?: { id: number; first_name?: string; last_name?: string; username?: string; title?: string } } }[] };
  const seen = new Map<string, string>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat;
    if (!chat) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id);
    seen.set(String(chat.id), name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}
