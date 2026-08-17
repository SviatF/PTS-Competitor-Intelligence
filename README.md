# PTS Competitor Intelligence

Competitive advertising monitoring service for PTS Cooperation.

## V1 scope

- Monitor configured competitors
- Collect public Meta Ad Library ad snapshots through a collector abstraction
- Normalize and fingerprint ads
- Store projects, competitors, ads and detections in PostgreSQL
- Notify Telegram only when a previously unseen ad is detected
- Run checks on a schedule

## Stack

- Node.js 20+
- TypeScript
- Prisma ORM
- PostgreSQL
- Playwright
- Telegram Bot API

## Quick start

1. Copy `.env.example` to `.env`.
2. Add a PostgreSQL `DATABASE_URL`.
3. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
4. Run `npm install`.
5. Run `npx prisma migrate dev --name init`.
6. Run `npm run seed` to create the first test project/competitors.
7. Run `npm run dev`.

## Important

The Meta collector is intentionally isolated behind a provider interface because public Ad Library page markup can change and may apply automated-access restrictions. The rest of the system (database, deduplication, scheduling and Telegram notifications) does not depend on one collector implementation. If direct browser collection becomes unstable, the provider can be replaced with an approved external data source without rewriting the monitoring core.
