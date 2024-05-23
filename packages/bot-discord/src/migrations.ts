import { Migrations } from '@ramus/bot';

export const migrations: Migrations = {
  key: 'discord',
  fn: [
    () => ({
      name: 'Initial setup',
      query: `
        CREATE TABLE IF NOT EXISTS ramus.discord_channels (
          conversation_id uuid PRIMARY KEY,
          guild text NOT NULL,
          channel text NOT NULL,
          started_by text NOT NULL,
          started_at timestamptz NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS channel_idx ON ramus.channels (channel);

        CREATE TABLE IF NOT EXISTS ramus.discord_org_mapping (
          discord_guild_id text PRIMARY KEY,
          organization_id uuid NOT NULL
        );

        CREATE INDEX IF NOT EXISTS guild_org_idx ON ramus.guild_organizations (organization_id);

        CREATE TABLE ramus.discord_user_mapping (
          discord_user_id text NOT NULL,
          discord_guild_id text NOT NULL REFERENCES ramus.guild_organizations (discord_guild_id) ON DELETE CASCADE ON UPDATE CASCADE,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL,
          PRIMARY KEY (discord_user_id, discord_guild_id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS user_org_idx ON ramus.discord_user_mapping (organization_id, user_id);
      `,
    }),
  ],
};
