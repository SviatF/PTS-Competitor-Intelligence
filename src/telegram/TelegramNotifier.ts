import { env } from '../config/env.js';
import type { CollectedAd } from '../domain/ad.js';

type NotificationContext = {
  projectName: string;
  geo: string;
  competitorName: string;
  ad: CollectedAd;
};

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value: string | undefined, limit = 650) {
  if (!value) return '—';
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function stringFromRaw(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class TelegramNotifier {
  isConfigured() {
    return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  }

  private apiUrl(method: string) {
    return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  }

  private buildCaption(ctx: NotificationContext) {
    const advertiser = stringFromRaw(ctx.ad.raw, 'advertiser');
    const startedAt = stringFromRaw(ctx.ad.raw, 'startedAt');

    return [
      '🚨 <b>NEW COMPETITOR AD</b>',
      '',
      `<b>Project:</b> ${escapeHtml(ctx.projectName)}`,
      `<b>Competitor:</b> ${escapeHtml(ctx.competitorName)}`,
      advertiser ? `<b>Advertiser:</b> ${escapeHtml(advertiser)}` : '',
      `<b>GEO:</b> ${escapeHtml(ctx.geo)}`,
      `<b>Format:</b> ${ctx.ad.format || 'UNKNOWN'}`,
      ctx.ad.externalId ? `<b>Library ID:</b> ${escapeHtml(ctx.ad.externalId)}` : '',
      startedAt ? `<b>Started:</b> ${escapeHtml(startedAt)}` : '',
      '',
      `<b>Text:</b>\n${escapeHtml(truncate(ctx.ad.primaryText))}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildKeyboard(ctx: NotificationContext) {
    const row: Array<{ text: string; url: string }> = [];
    if (ctx.ad.adLibraryUrl) row.push({ text: '🔎 Open Ad Library', url: ctx.ad.adLibraryUrl });
    if (ctx.ad.landingUrl) row.push({ text: '🌐 Open Landing', url: ctx.ad.landingUrl });
    return row.length ? { inline_keyboard: [row] } : undefined;
  }

  private async send(method: string, body: Record<string, unknown>) {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
  }

  async sendNewAd(ctx: NotificationContext) {
    if (!this.isConfigured()) {
      console.log('[telegram] skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured');
      return;
    }

    const caption = this.buildCaption(ctx);
    const replyMarkup = this.buildKeyboard(ctx);

    if (ctx.ad.creativeUrl && ctx.ad.format === 'IMAGE') {
      try {
        await this.send('sendPhoto', {
          chat_id: env.TELEGRAM_CHAT_ID,
          photo: ctx.ad.creativeUrl,
          caption,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
        return;
      } catch (error) {
        console.warn('[telegram] sendPhoto failed, falling back to text', error);
      }
    }

    if (ctx.ad.creativeUrl && ctx.ad.format === 'VIDEO') {
      try {
        await this.send('sendVideo', {
          chat_id: env.TELEGRAM_CHAT_ID,
          video: ctx.ad.creativeUrl,
          caption,
          parse_mode: 'HTML',
          supports_streaming: true,
          reply_markup: replyMarkup,
        });
        return;
      } catch (error) {
        console.warn('[telegram] sendVideo failed, falling back to text', error);
      }
    }

    await this.send('sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: caption,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  }
}
