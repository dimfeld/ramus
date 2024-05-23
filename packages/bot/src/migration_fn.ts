import { Migrations } from './migrations.js';

export const migrations: Migrations = {
  key: 'main',
  fn: [
    () => ({
      name: 'Initial migration',
      query: `
        CREATE TABLE IF NOT EXISTS ramus.conversations (
          conversation_id uuid PRIMARY KEY,
          organization uuid NOT NULL,
          platform text NOT NULL,
          active boolean NOT NULL DEFAULT TRUE,
          started_by uuid NOT NULL,
          started_at timestamp NOT NULL DEFAULT NOW(),
        );

        CREATE TABLE ramus.vars (
          key text PRIMARY KEY,
          value jsonb NOT NULL
        );
      `,
    }),
  ],
};
