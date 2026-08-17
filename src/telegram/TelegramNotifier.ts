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

function truncate(value: string | undefined, limit = 1200) {
  if (!value) return '—';
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export class TelegramNotifier {
  isConfigured() {
    return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  }

  async sendNewAd(ctx: NotificationContext) {
    if (!this.isConfigured()) {
      console.log('[telegram] skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured');
      return;
    }

    const text = [
      '🚨 <b>NEW COMPETITOR AD</b>',
      '',
      `<b>Project:</b> ${escapeHtml(ctx.projectName)}`,
      `<b>Competitor:</b> ${escapeHtml(ctx.competitorName)}`,
      `<b>Platform:</b> ${ctx.ad.source}`,
      `<b>GEO:</b> ${escapeHtml(ctx.geo)}`,
      `<b>Format:</b> ${ctx.ad.format || 'UNKNOWN'}`,
      ctx.ad.externalId ? `<b>Library ID:</b> ${escapeHtml(ctx.ad.externalId)}` : '',
      '',
      `<b>Text:</b>\n${escapeHtml(truncate(ctx.ad.primaryText))}`,
      '',
      `<b>Landing:</b> ${ctx.ad.landingUrl ? escapeHtml(ctx.ad.landingUrl) : '—'}`,
      ctx.ad.adLibraryUrl ? `<b>Ad Library:</b> ${escapeHtml(ctx.ad.adLibraryUrl)}` : '',
      ctx.ad.creativeUrl ? `<b>Creative:</b> ${escapeHtml(ctx.ad.creativeUrl)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API failed: ${response.status} ${await response.text()}`);
    }
  }
}
