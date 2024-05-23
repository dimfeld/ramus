import {
  pgTable,
  boolean,
  index,
  text,
  uuid,
  uniqueIndex,
  timestamp,
  jsonb,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { ramusSchema } from '@ramus/bot';

export const channels = ramusSchema.table(
  'discord_channels',
  {
    conversation_id: uuid('conversation_id').primaryKey(),
    guild: text('guild').notNull(),
    channel: text('channel').notNull(),
    // The Discord ID of the user who started the conversation
    started_by: text('started_by').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return {
      channel_idx: uniqueIndex('channel_idx').on(table.channel),
    };
  }
);

export const guildOrganizations = ramusSchema.table(
  'discord_org_mapping',
  {
    discord_guild_id: text('discord_guild_id').primaryKey(),
    organization_id: uuid('organization_id').notNull(),
  },
  (table) => {
    return {
      organization_idx: index('organization_idx').on(table.organization_id),
    };
  }
);

export const guildUsers = ramusSchema.table(
  'discord_user_mapping',
  {
    discord_user_id: text('discord_user_id').notNull(),
    discord_guild_id: text('discord_guild_id')
      .notNull()
      .references(() => guildOrganizations.discord_guild_id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    organization_id: uuid('organization_id').notNull(),
    user_id: uuid('user_id').notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.discord_user_id, table.discord_guild_id] }),
      user_org_idx: uniqueIndex('user_org_idx').on(table.organization_id, table.user_id),
    };
  }
);

export const tables = {
  channels,
  guildOrganizations,
  guildUsers,
};
