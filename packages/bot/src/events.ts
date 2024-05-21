export interface BaseIncomingEvent {
  /** The ID of the event. */
  id: string;
  /** The platform-independent ID of the conversation. */
  conversation_id: string;
}

/** An event from the platform */
export interface IncomingChatEvent extends BaseIncomingEvent {
  type: 'chat';
  message: string;
}

/** Mark a conversation as finished. The bot will ignore further messages unless the conversation is reopened. */
export interface IncomingFinishEvent extends BaseIncomingEvent {
  type: 'finish';
}

/** Reopen a conversation so the bot will continue to process messages. */
export interface IncomingReopenEvent extends BaseIncomingEvent {
  type: 'reopen';
}

/** Create a new conversation. */
export interface IncomingNewConversationEvent extends BaseIncomingEvent {
  type: 'new_conversation';
  message: string;
}

/** Events that the adapter can send to the bot. */
export type IncomingEvent =
  | IncomingChatEvent
  | IncomingFinishEvent
  | IncomingReopenEvent
  | IncomingNewConversationEvent;

/** Common fields in every outgoing event. */
export interface BaseOutgoingEvent {
  /** The ID of the event. */
  id: string;
  /** The adapter-independent ID of the conversation. */
  conversation_id: string;
}

/** Send a chat to the user. */
export interface OutgoingChatEvent extends BaseOutgoingEvent {
  type: 'chat';
  message: string;
  /** The ID of the message to update, if any. The system will only ever ask to update recent messages. */
  message_id?: string;
  /** If this is a new message, */
  operation?: 'create' | 'replace' | 'append';
}

/** A message to the adapter. */
export type OutgoingEvent = OutgoingChatEvent;
