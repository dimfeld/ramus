import { pgTable, boolean, index, text, uuid, uniqueIndex } from 'drizzle-orm/pg-core';

export const channels = pgTable(
  'ramus.discord_channels',
  {
    conversation_id: uuid('conversation_id').primaryKey(),
    guild: text('guild').notNull(),
    channel: text('channel').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (table) => {
    return {
      channel_idx: uniqueIndex('channel_idx').on(table.channel),
    };
  }
);

export const guildOrganizations = pgTable(
  'ramus.discord_org_mapping',
  {
    guild: text('guild').primaryKey(),
    organization: uuid('organization').notNull(),
  },
  (table) => {
    return {
      organization_idx: index('organization_idx').on(table.organization),
    };
  }
);
