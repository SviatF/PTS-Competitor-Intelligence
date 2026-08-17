import { MetaAdLibraryCollector } from './collectors/meta/MetaAdLibraryCollector.js';
import { TelegramNotifier } from './telegram/TelegramNotifier.js';

const competitors = [
  {
    id: 'mriydiy-camp',
    name: 'MRIYDIY Camp',
    website: 'https://www.instagram.com/mriydiy.camp/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=mriydiy%20camp&search_type=keyword_unordered',
  },
  {
    id: 'emily-kids-camp',
    name: 'Emily Kids Camp',
    website: 'https://www.instagram.com/emily_kids_camp/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=emily%20kids%20camp&search_type=keyword_unordered',
  },
  {
    id: 'supercamp-ua',
    name: 'Supercamp UA',
    website: 'https://www.instagram.com/supercamp.ua/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=supercamp%20ua&search_type=keyword_unordered',
  },
];

const collector = new MetaAdLibraryCollector();
const notifier = new TelegramNotifier();

async function main() {
  console.log('[smoke] starting database-free scan');

  let total = 0;

  for (const competitor of competitors) {
    console.log(`[smoke] scanning ${competitor.name}`);
    try {
      const ads = await collector.collect(competitor);
      console.log(`[smoke] ${competitor.name}: found ${ads.length} ad snapshots`);
      total += ads.length;

      for (const ad of ads) {
        console.log(
          JSON.stringify({
            competitor: competitor.name,
            source: ad.source,
            externalId: ad.externalId,
            format: ad.format,
            landingUrl: ad.landingUrl,
            creativeUrl: ad.creativeUrl,
            adLibraryUrl: ad.adLibraryUrl,
            text: ad.primaryText,
          }),
        );

        await notifier.sendNewAd({
          projectName: 'The Camp — SMOKE TEST',
          geo: 'ALL',
          competitorName: competitor.name,
          ad,
        });
      }
    } catch (error) {
      console.error(`[smoke] ${competitor.name} failed`, error);
    }
  }

  console.log(`[smoke] finished; total=${total}`);
}

main().catch((error) => {
  console.error('[smoke] fatal', error);
  process.exit(1);
});
