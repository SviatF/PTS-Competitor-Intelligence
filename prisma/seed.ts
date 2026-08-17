import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const projectName = 'The Camp';
const geo = 'UA';

const competitors = [
  {
    name: 'MRIYDIY Camp',
    instagramUrl: 'https://www.instagram.com/mriydiy.camp/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=UA&q=mriydiy%20camp&search_type=keyword_unordered',
  },
  {
    name: 'Emily Kids Camp',
    instagramUrl: 'https://www.instagram.com/emily_kids_camp/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=UA&q=emily%20kids%20camp&search_type=keyword_unordered',
  },
  {
    name: 'Supercamp UA',
    instagramUrl: 'https://www.instagram.com/supercamp.ua/',
    metaAdLibraryUrl:
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=UA&q=supercamp%20ua&search_type=keyword_unordered',
  },
];

async function main() {
  let project = await db.project.findFirst({ where: { name: projectName } });

  if (!project) {
    project = await db.project.create({
      data: { name: projectName, geo, active: true },
    });
  } else {
    project = await db.project.update({
      where: { id: project.id },
      data: { geo, active: true },
    });
  }

  for (const competitor of competitors) {
    const existing = await db.competitor.findFirst({
      where: { projectId: project.id, name: competitor.name },
    });

    const data = {
      website: competitor.instagramUrl,
      metaAdLibraryUrl: competitor.metaAdLibraryUrl,
      active: true,
    };

    if (existing) {
      await db.competitor.update({ where: { id: existing.id }, data });
    } else {
      await db.competitor.create({
        data: {
          projectId: project.id,
          name: competitor.name,
          ...data,
        },
      });
    }
  }

  console.log(`Seeded ${projectName}: ${competitors.length} active competitors`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
