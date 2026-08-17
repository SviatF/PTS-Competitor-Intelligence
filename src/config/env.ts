import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  MONITOR_CRON: z.string().default('*/30 * * * *'),
  META_HEADLESS: z.string().default('true').transform((v) => v !== 'false'),
});

export const env = envSchema.parse(process.env);
