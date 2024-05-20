import { Client, Events, IntentsBitField } from 'discord.js';
import {
  BotManager,
  BotAdapter,
  OutgoingEvent,
  OutgoingChatEvent,
  IncomingEventCallback,
  IncomingEvent,
} from '@ramus/bot';

export class DiscordBotAdapter implements BotAdapter {
  name = 'discord';

  client: Client;
  receive: IncomingEventCallback;

  // Need a database handle to store conversation info, and information to connect the bot to Discord
  constructor(manager: BotManager) {
    this.receive = (event: IncomingEvent) => manager.receiveEvent(this.name, event);

    let intents = new IntentsBitField();
    intents.add(
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages
    );
    this.client = new Client({
      intents,
    });

    // TODO database migrations if necessary
  }

  async connect(token: string) {
    await this.client.login(token);
  }

  async sendChat(event: OutgoingChatEvent): Promise<void> {
    throw new Error('Method not implemented.');
    // look up the conversation, send the event
  }
}
