import { and, eq } from 'drizzle-orm';
import { EventEmitter } from 'events';
import { LRUCache } from 'lru-cache';
import { conversations, postgresClient } from './db.js';
import { IncomingEvent, OutgoingChatEvent, OutgoingEvent } from './events.js';
import { uuidv7 } from 'uuidv7';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export * from './db.js';
export * from './events.js';
export * from './migrations.js';

import { migrations } from './migration_fn.js';

export interface BotAdapter {
  name: string;
  sendChat(event: OutgoingChatEvent): any;
}

export class BotManager extends EventEmitter<{ event: [IncomingEvent] }> {
  adapters: Record<string, BotAdapter> = {};

  conversationPlatform: LRUCache<string, string>;

  constructor() {
    super();
    this.conversationPlatform = new LRUCache({
      max: 1000,
    });
  }

  migrations() {
    return migrations;
  }

  /** Receive an event from one of the chat platform adapters. */
  async receiveEvent(adapter: string, event: IncomingEvent) {
    this.conversationPlatform.set(event.conversation_id, adapter);

    // Based on the conversation ID, look up the metadata for the conversation and use that to pass it on to the
    // proper place.
    if (event.type === 'chat') {
      // test: Just send it back to the chat platform as a test
      setImmediate(() => {
        this.adapters[adapter].sendChat({
          conversation_id: event.conversation_id,
          id: uuidv7(),
          type: 'chat',
          operation: 'create',
          message: `What do you think about "${event.message}"?`,
        });
      });
    }

    if (event.type === 'reopen') {
      await this.setConversationActive(postgresClient(), event.conversation_id, true);
    }

    this.emit('event', event);
  }

  /** Send an event to one of the chat platform adapters. */
  async sendEvent(event: OutgoingEvent) {
    // TODO do this in a span
    let platform = this.conversationPlatform.get(event.conversation_id);
    if (!platform) {
      platform = await this.lookupConversationPlatform(event.conversation_id);

      if (!platform) {
        throw new Error(`No platform found for conversation ${event.conversation_id}`);
      }
    }

    const adapter = this.adapters[platform];
    if (!adapter) {
      throw new Error(
        `Platform ${platform} for conversation ${event.conversation_id} is not enabled`
      );
    }

    switch (event.type) {
      case 'chat':
        adapter.sendChat(event);
        break;
    }
  }

  async lookupConversationPlatform(id: string) {
    let result = await postgresClient()
      .select()
      .from(conversations)
      .where(eq(conversations.conversation_id, id));
    let platform = result[0]?.platform;
    if (platform) {
      this.conversationPlatform.set(id, platform);
    }
    return platform;
  }

  registerAdapter(adapter: BotAdapter) {
    this.adapters[adapter.name] = adapter;
  }

  async newConversation(
    tx: PostgresJsDatabase,
    platform: string,
    organization: string,
    user: string
  ) {
    const id = uuidv7();
    this.conversationPlatform.set(id, platform);

    await tx.insert(conversations).values({
      conversation_id: id,
      organization,
      platform,
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
