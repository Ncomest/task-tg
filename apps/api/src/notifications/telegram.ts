export interface TelegramSender {
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface TelegramSenderOptions {
  botToken: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Minimal Bot API client for one-way notifications. Errors never include the
 * request URL because it contains the bot token.
 */
export function createTelegramSender(options: TelegramSenderOptions): TelegramSender {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    async sendMessage(chatId, text) {
      const response = await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
    },
  };
}
