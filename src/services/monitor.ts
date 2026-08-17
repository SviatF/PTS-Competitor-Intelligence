import type { AdCollector } from '../domain/ad.js';
import { db } from '../database/client.js';
import { TelegramNotifier } from '../telegram/TelegramNotifier.js';

export class MonitorService {
  constructor(
    private readonly collector: AdCollector,
    private readonly notifier: TelegramNotifier,
  ) {}

  async runOnce() {
    const competitors = await db.competitor.findMany({
      where: { active: true, project: { active: true }, metaAdLibraryUrl: { not: null } },
      include: { project: true },
    });

    console.log(`[monitor] scanning ${competitors.length} competitors`);

    for (const competitor of competitors) {
      try {
        const collected = await this.collector.collect(competitor);
        console.log(`[monitor] ${competitor.name}: ${collected.length} ads collected`);

        for (const ad of collected) {
          const existing = await db.ad.findUnique({
            where: {
              competitorId_source_fingerprint: {
                competitorId: competitor.id,
                source: ad.source,
                fingerprint: ad.fingerprint,
              },
            },
          });

          if (existing) {
            await db.ad.update({
              where: { id: existing.id },
              data: {
                lastSeenAt: new Date(),
                landingUrl: ad.landingUrl,
                creativeUrl: ad.creativeUrl,
                rawJson: ad.raw,
              },
            });
            continue;
          }

          const created = await db.ad.create({
            data: {
              competitorId: competitor.id,
              source: ad.source,
              externalId: ad.externalId,
              fingerprint: ad.fingerprint,
              format: ad.format,
              primaryText: ad.primaryText,
              headline: ad.headline,
              cta: ad.cta,
              landingUrl: ad.landingUrl,
              creativeUrl: ad.creativeUrl,
              adLibraryUrl: ad.adLibraryUrl,
              rawJson: ad.raw,
              detections: { create: { status: 'NEW' } },
            },
            include: { detections: true },
          });

          const detection = created.detections[0];

          try {
            await this.notifier.sendNewAd({
              projectName: competitor.project.name,
              geo: competitor.project.geo,
              competitorName: competitor.name,
              ad,
            });

            if (detection && this.notifier.isConfigured()) {
              await db.detection.update({
                where: { id: detection.id },
                data: { status: 'NOTIFIED', notifiedAt: new Date() },
              });
            }
          } catch (error) {
            console.error(`[telegram] failed for ad ${created.id}`, error);
          }
        }
      } catch (error) {
        console.error(`[monitor] competitor failed: ${competitor.name}`, error);
      }
    }
  }
}
