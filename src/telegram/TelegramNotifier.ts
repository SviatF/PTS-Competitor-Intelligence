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

  private async sendJson(method: string, body: Record<string, unknown>) {
    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
  }

  private async downloadMedia(url: string) {
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36',
        referer: 'https://www.facebook.com/',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status}`);
    }

    const bytes = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    return { bytes, contentType };
  }

  private async uploadMedia(
    method: 'sendPhoto' | 'sendVideo',
    field: 'photo' | 'video',
    ctx: NotificationContext,
  ) {
    if (!ctx.ad.creativeUrl) throw new Error('Missing creative URL');

    const { bytes, contentType } = await this.downloadMedia(ctx.ad.creativeUrl);
    const extension = method === 'sendVideo' ? 'mp4' : contentType.includes('png') ? 'png' : 'jpg';
    const filename = `competitor-${ctx.ad.externalId || Date.now()}.${extension}`;

    const form = new FormData();
    form.append('chat_id', env.TELEGRAM_CHAT_ID!);
    form.append(field, new Blob([bytes], { type: contentType }), filename);
    form.append('caption', this.buildCaption(ctx));
    form.append('parse_mode', 'HTML');
    if (method === 'sendVideo') form.append('supports_streaming', 'true');

    const keyboard = this.buildKeyboard(ctx);
    if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));

    const response = await fetch(this.apiUrl(method), {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Telegram ${method} upload failed: ${response.status} ${await response.text()}`);
    }
  }

  async sendNewAd(ctx: NotificationContext) {
    if (!this.isConfigured()) {
      console.log('[telegram] skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured');
      return;
    }

    if (ctx.ad.creativeUrl && ctx.ad.format === 'IMAGE') {
      try {
        await this.uploadMedia('sendPhoto', 'photo', ctx);
        return;
      } catch (error) {
        console.warn('[telegram] photo upload failed, falling back to text', error);
      }
    }

    if (ctx.ad.creativeUrl && ctx.ad.format === 'VIDEO') {
      try {
        await this.uploadMedia('sendVideo', 'video', ctx);
        return;
      } catch (error) {
        console.warn('[telegram] video upload failed, falling back to text', error);
      }
    }

    await this.sendJson('sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: this.buildCaption(ctx),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: this.buildKeyboard(ctx),
    });
  }
}
