import { env } from '../config/env.js';
import type { CollectedAd } from '../domain/ad.js';

type NotificationContext = {
  projectName: string;
  geo: string;
  competitorName: string;
  chatId?: string | number;
  eventType?: 'NEW' | 'REACTIVATED';
  ad: CollectedAd;
};

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const truncate = (value?: string, limit = 300) => !value ? '—' : value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
function stringFromRaw(raw: Record<string, unknown>, key: string) { const value = raw[key]; return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

function inferGoal(ad: CollectedAd) {
  const destinationType = stringFromRaw(ad.raw, 'destinationType');
  if (destinationType === 'MESSAGES') return 'Дірект / повідомлення';
  if (destinationType === 'WHATSAPP') return 'WhatsApp';
  if (destinationType === 'LEAD_FORM') return 'Lead Form';
  if (destinationType === 'WEBSITE') return 'Сайт';
  const cta = (ad.cta || '').toLowerCase();
  if (cta.includes('message') || cta.includes('повідомлення')) return 'Дірект / повідомлення';
  if (ad.format === 'VIDEO') return 'Перегляди відео / взаємодія';
  return 'Охоплення / взаємодія';
}

function formatLabel(format: CollectedAd['format']) {
  if (format === 'IMAGE') return 'IMAGE';
  if (format === 'VIDEO') return 'VIDEO';
  if (format === 'CAROUSEL') return 'CAROUSEL';
  return 'UNKNOWN';
}

function sourceLabel(source: CollectedAd['source']) {
  if (source === 'META') return 'Meta (Facebook + Instagram)';
  if (source === 'GOOGLE') return 'Google Ads';
  return 'TikTok Ads';
}

function advertiserField(source: CollectedAd['source']) {
  if (source === 'META') return 'FB-page';
  if (source === 'GOOGLE') return 'Advertiser';
  return 'TikTok advertiser';
}

function idField(source: CollectedAd['source']) {
  if (source === 'META') return 'Library ID';
  if (source === 'GOOGLE') return 'Google Ad ID';
  return 'TikTok Ad ID';
}

export class TelegramNotifier {
  isConfigured() { return Boolean(env.TELEGRAM_BOT_TOKEN); }
  private apiUrl(method: string) { return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`; }
  private resolveChatId(ctx: NotificationContext) { const chatId = ctx.chatId ?? env.TELEGRAM_CHAT_ID; if (!chatId) throw new Error('Missing Telegram chat id'); return String(chatId); }

  private buildCaption(ctx: NotificationContext) {
    const advertiser = stringFromRaw(ctx.ad.raw, 'advertiser');
    const startedAt = stringFromRaw(ctx.ad.raw, 'startedAt');
    const divider = '____________________________';
    const title = ctx.eventType === 'REACTIVATED' ? '♻️ <b>РЕКЛАМУ КОНКУРЕНТА ЗАПУЩЕНО ЗНОВУ</b>' : '❗ <b>НОВА РЕКЛАМА У КОНКУРЕНТІВ</b> ❗';
    return [
      title,
      `<b>Проект:</b> ${escapeHtml(ctx.projectName)}`,
      `<b>Конкурент:</b> ${escapeHtml(ctx.competitorName)}`,
      `<b>Канал:</b> ${sourceLabel(ctx.ad.source)}`,
      divider,
      advertiser ? `<b>${advertiserField(ctx.ad.source)}:</b> ${escapeHtml(advertiser)}` : `<b>${advertiserField(ctx.ad.source)}:</b> —`,
      `<b>ГЕО:</b> ${escapeHtml(ctx.geo)}`,
      `<b>Формат:</b> ${formatLabel(ctx.ad.format)}`,
      `<b>Ціль:</b> ${escapeHtml(inferGoal(ctx.ad))}`,
      `<b>CTA:</b> ${ctx.ad.cta ? escapeHtml(ctx.ad.cta) : '—'}`,
      divider,
      ctx.ad.externalId ? `<b>${idField(ctx.ad.source)}:</b> ${escapeHtml(ctx.ad.externalId)}` : '',
      startedAt ? `<b>Старт:</b> ${escapeHtml(startedAt)}` : '',
      '',
      '<b>Опис:</b>',
      escapeHtml(truncate(ctx.ad.primaryText, 300)),
      ctx.ad.landingUrl ? '' : undefined,
      ctx.ad.landingUrl ? `<b>Лінк:</b> ${escapeHtml(ctx.ad.landingUrl)}` : undefined,
    ].filter((line): line is string => typeof line === 'string').join('\n');
  }

  private buildKeyboard(ctx: NotificationContext) {
    const row: Array<{ text: string; url: string }> = [];
    if (ctx.ad.adLibraryUrl) row.push({ text: ctx.ad.source === 'META' ? '🔎 Meta Ad Library' : ctx.ad.source === 'GOOGLE' ? '🔎 Google Transparency' : '🔎 TikTok Ad Library', url: ctx.ad.adLibraryUrl });
    if (ctx.ad.landingUrl) row.push({ text: '🌐 Відкрити сайт', url: ctx.ad.landingUrl });
    return row.length ? { inline_keyboard: [row] } : undefined;
  }

  private async sendJson(method: string, body: Record<string, unknown>) {
    const response = await fetch(this.apiUrl(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
  }

  private async downloadMedia(url: string, source: CollectedAd['source']) {
    const referer = source === 'META' ? 'https://www.facebook.com/' : source === 'GOOGLE' ? 'https://adstransparency.google.com/' : 'https://www.tiktok.com/';
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36', referer, accept: '*/*' }, redirect: 'follow' });
    if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (!bytes.byteLength) throw new Error('Media download returned empty body');
    return { bytes, contentType };
  }

  private async uploadMedia(method: 'sendPhoto' | 'sendVideo', field: 'photo' | 'video', ctx: NotificationContext) {
    if (!ctx.ad.creativeUrl) throw new Error('Missing creative URL');
    const { bytes, contentType } = await this.downloadMedia(ctx.ad.creativeUrl, ctx.ad.source);
    const extension = method === 'sendVideo' ? 'mp4' : contentType.includes('png') ? 'png' : 'jpg';
    const form = new FormData();
    form.append('chat_id', this.resolveChatId(ctx));
    form.append(field, new Blob([bytes], { type: contentType }), `competitor-${ctx.ad.externalId || Date.now()}.${extension}`);
    form.append('caption', this.buildCaption(ctx));
    form.append('parse_mode', 'HTML');
    if (method === 'sendVideo') form.append('supports_streaming', 'true');
    const keyboard = this.buildKeyboard(ctx); if (keyboard) form.append('reply_markup', JSON.stringify(keyboard));
    const response = await fetch(this.apiUrl(method), { method: 'POST', body: form });
    if (!response.ok) throw new Error(`Telegram ${method} upload failed: ${response.status} ${await response.text()}`);
  }

  private async sendMediaByUrl(method: 'sendPhoto' | 'sendVideo', field: 'photo' | 'video', ctx: NotificationContext) {
    if (!ctx.ad.creativeUrl) throw new Error('Missing creative URL');
    await this.sendJson(method, { chat_id: this.resolveChatId(ctx), [field]: ctx.ad.creativeUrl, caption: this.buildCaption(ctx), parse_mode: 'HTML', ...(method === 'sendVideo' ? { supports_streaming: true } : {}), reply_markup: this.buildKeyboard(ctx) });
  }

  async sendNewAd(ctx: NotificationContext) {
    if (!this.isConfigured()) return;
    if (ctx.ad.creativeUrl && ctx.ad.format === 'IMAGE') { try { await this.uploadMedia('sendPhoto', 'photo', ctx); return; } catch { try { await this.sendMediaByUrl('sendPhoto', 'photo', ctx); return; } catch {} } }
    if (ctx.ad.creativeUrl && ctx.ad.format === 'VIDEO') { try { await this.uploadMedia('sendVideo', 'video', ctx); return; } catch { try { await this.sendMediaByUrl('sendVideo', 'video', ctx); return; } catch {} } }
    await this.sendJson('sendMessage', { chat_id: this.resolveChatId(ctx), text: this.buildCaption(ctx), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: this.buildKeyboard(ctx) });
  }

  async sendStopped(args: { chatId: string | number; projectName: string; competitorName: string; adId?: string; libraryId?: string; source?: CollectedAd['source']; startedAt?: string; lastSeenAt?: string }) {
    const source = args.source || 'META';
    const resolvedId = args.adId || args.libraryId || '—';
    const text = [
      '⛔ <b>РЕКЛАМУ КОНКУРЕНТА ЗУПИНЕНО</b>', '',
      `<b>Проект:</b> ${escapeHtml(args.projectName)}`,
      `<b>Конкурент:</b> ${escapeHtml(args.competitorName)}`,
      `<b>Канал:</b> ${sourceLabel(source)}`,
      `<b>${idField(source)}:</b> ${escapeHtml(resolvedId)}`,
      args.startedAt ? `<b>Старт:</b> ${escapeHtml(args.startedAt)}` : '',
      args.lastSeenAt ? `<b>Останній раз бачили:</b> ${escapeHtml(args.lastSeenAt)}` : '', '',
      '<i>Статус визначено після 3 послідовних перевірок, у яких оголошення не було серед активних.</i>',
    ].filter(Boolean).join('\n');
    await this.sendJson('sendMessage', { chat_id: String(args.chatId), text, parse_mode: 'HTML', disable_web_page_preview: true });
  }
}
