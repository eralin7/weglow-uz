import { env } from './util.ts';

/** Sends a message to the sales chat if TG_BOT_TOKEN and TG_CHAT_ID are set. Never throws. */
export async function notify(text: string): Promise<void> {
  const token = env('TG_BOT_TOKEN');
  const chat = env('TG_CHAT_ID');
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error('telegram notify failed', e);
  }
}
