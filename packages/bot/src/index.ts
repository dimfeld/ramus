import { IncomingEvent, OutgoingChatEvent, OutgoingEvent } from './events.js';
import { randomUUID } from 'node:crypto';

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
      this.adapters[adapter].sendChat({
        conversation_id: event.conversation_id,
        id: randomUUID(),
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

  newConversationId() {
    // TODO use a uuid v7
    return randomUUID();
  }
}

export type IncomingEventCallback = (event: IncomingEvent) => void;
