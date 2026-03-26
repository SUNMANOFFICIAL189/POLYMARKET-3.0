import { logger } from './logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

/**
 * Send a Telegram notification. Fire-and-forget — never blocks or throws.
 */
export function sendTelegramAlert(message: string): void {
  if (!BOT_TOKEN || !CHAT_ID) return;

  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
    }),
  }).catch(err => {
    logger.debug(`Telegram send failed: ${err?.message?.slice(0, 50)}`);
  });
}
