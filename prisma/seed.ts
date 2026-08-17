import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const project = await db.project.create({
    data: {
      name: 'TEST PROJECT',
      geo: 'PL',
      active: false,
      competitors: {
        create: [
          {
            name: 'Replace with competitor',
            website: 'https://example.com',
            metaAdLibraryUrl: 'https://www.facebook.com/ads/library/',
            active: false,
          },
        ],
      },
    },
  });

  console.log(`Seeded disabled placeholder project: ${project.id}`);
  console.log('Replace it with a real project/competitors before enabling monitoring.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
