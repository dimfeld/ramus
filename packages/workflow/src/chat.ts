import { WorkflowEventBase } from './events.js';

export interface MessageToUserEventData {
  /** The ID of a message, used so that chats can append or replace an existing message. */
  id?: string;
  text: string;
  /** If id is given, set this to true to completely replace the contents of the message. Otherwise it should be
   * appended. */
  replace?: boolean;
}

export type MessageToUserEvent = WorkflowEventBase<'chat', MessageToUserEventData>;

export interface MessageFromUserEventData {
  text: string;
}

export const MESSAGE_FROM_USER = 'chat';
export interface MessageFromUserEvent {
  text: string;
  buttonId?: string;
}
