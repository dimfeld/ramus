import { and, eq } from 'drizzle-orm';
import { conversations, postgresClient } from './db.js';
import { IncomingEvent, OutgoingChatEvent, OutgoingEvent } from './events.js';
import { uuidv7 } from 'uuidv7';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export * from './db.js';
export * from './events.js';
export * from './migrations.js';

export interface BotAdapter {
  name: string;
  sendChat(event: OutgoingChatEvent): Promise<void>;
}

export class BotManager {
  adapters: Record<string, BotAdapter> = {};

  receiveEvent(adapter: string, event: IncomingEvent) {
    // Based on the conversation ID, look up the metadata for the conversation and use that to pass it on to the
    // proper place.
    if (event.type === 'chat') {
      // Just send it back to the chat platform as a test
      this.adapters[adapter].sendChat({
        conversation_id: event.conversation_id,
        id: uuidv7(),
        type: 'chat',
        operation: 'create',
        message: `What do you think about "${event.message}"?`,
      });
    }

    // Some kind of streaming event system may be good in the long run here. For now just in-process should be just
    // fine.
  }

  registerAdapter(adapter: BotAdapter) {
    this.adapters[adapter.name] = adapter;
  }

  async newConversation(
    tx: PostgresJsDatabase,
    adapterName: string,
    organization: string,
    user: string
  ) {
    const id = uuidv7();

    await tx.insert(conversations).values({
      conversation_id: id,
      organization,
      platform: adapterName,
      active: true,
      started_by: user,
    });

    return id;
  }

  async setConversationActive(tx: PostgresJsDatabase, conversationId: string, active: boolean) {
    await tx
      .update(conversations)
      .set({ active })
      .where(and(eq(conversations.conversation_id, conversationId)));
  }
}

export type IncomingEventCallback = (event: IncomingEvent) => void;
