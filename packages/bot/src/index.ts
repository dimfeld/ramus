import { IncomingEvent, OutgoingChatEvent, OutgoingEvent } from './events.js';

export * from './events.js';

export interface BotAdapter {
  name: string;
  sendChat(event: OutgoingChatEvent): Promise<void>;
}

export class BotManager {
  adapters: Record<string, BotAdapter> = {};

  receiveEvent(adapter: string, event: IncomingEvent) {
    // Each BotAdapter should get a function that calls this with the appropriate adapter name
    // TODO process the event and pass it on to the relevant place.
    // Based on the conversation ID, look up the metadata for the conversation and use that to pass it on to the
    // proper place.
    // Some kind of streaming event system may be good in the long run here. For now just in-process should be just
    // fine.
  }

  registerAdapter(adapter: BotAdapter) {
    this.adapters[adapter.name] = adapter;
  }
}

export type IncomingEventCallback = (event: IncomingEvent) => void;
