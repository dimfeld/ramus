import {
  ChannelType,
  Client,
  Events,
  IntentsBitField,
  Message,
  REST,
  Routes,
  TextChannel,
} from 'discord.js';
import {
  BotManager,
  BotAdapter,
  OutgoingEvent,
  OutgoingChatEvent,
  IncomingEvent,
  postgresClient,
  conversations,
  Database,
} from '@ramus/bot';
import { LRUCache } from 'lru-cache';
import { eq, and } from 'drizzle-orm';

import { channels, guildOrganizations } from './db.js';
import { kvGet } from '@ramus/bot';
import { kvSet } from '@ramus/bot';
import { createThreadedConverationHandler } from './threaded_conversation.js';

export * from './migrations.js';
export * from './threaded_conversation.js';

import { migrations } from './migrations.js';

export interface DiscordConversation {
  conversation_id: string;
  guild: string;
  channel: string;
  active: boolean;
  started_by: string;
  org: string;
}

const COMMAND_VERSION = 0;

export class DiscordBotAdapter implements BotAdapter {
  name = 'discord';

  client: Client;
  manager: BotManager;

  conversationsById: LRUCache<string, DiscordConversation | false>;
  conversationsByChannel: LRUCache<string, DiscordConversation | false>;

  db: Database;

  constructor(manager: BotManager) {
    this.db = postgresClient();
    this.manager = manager;

    let intents = new IntentsBitField();
    intents.add(
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages
    );
    this.client = new Client({
      intents,
    });

    this.conversationsById = new LRUCache({
      max: 1000,
    });
    this.conversationsByChannel = new LRUCache({
      max: 1000,
    });
  }

  migrations() {
    return migrations;
  }

  receiveEvent(event: IncomingEvent) {
    this.manager.receiveEvent(this.name, event);
  }

  populateCache(id: string | null, channelId: string | null, channel: DiscordConversation | null) {
    // Set false to distinguish between "not in the cache" and "known no value"
    let c = channel || false;

    if (id) {
      this.conversationsById.set(id, c);
    }

    if (channelId) {
      this.conversationsByChannel.set(channelId, c);
    }
  }

  baseConversationGetQuery() {
    return this.db
      .select({
        conversation_id: channels.conversation_id,
        guild: channels.guild,
        channel: channels.channel,
        started_by: channels.started_by,
        active: conversations.active,
        org: guildOrganizations.organization_id,
      })
      .from(channels)
      .innerJoin(guildOrganizations, eq(guildOrganizations.discord_guild_id, channels.guild))
      .innerJoin(conversations, eq(conversations.conversation_id, channels.conversation_id));
  }

  async getConversationById(id: string): Promise<DiscordConversation | null> {
    let conversation = this.conversationsById.get(id);
    if (conversation != null) {
      return conversation || null;
    }

    conversation = (
      await this.baseConversationGetQuery().where(eq(channels.conversation_id, id))
    )[0];
    this.populateCache(id, conversation?.channel, conversation);

    return conversation;
  }

  async getConversationForChannel(channel: string): Promise<DiscordConversation | null> {
    let conversation = this.conversationsByChannel.get(channel);
    if (conversation != null) {
      return conversation || null;
    }

    let info =
      (await this.baseConversationGetQuery().where(eq(channels.channel, channel)))[0] ?? null;

    this.populateCache(info?.conversation_id, channel, info);

    return info;
  }

  async connect(clientId: string, token: string) {
    const currentCommandVersion: number = (await kvGet(this.db, 'discord:command_version')) ?? 0;

    if (currentCommandVersion < COMMAND_VERSION) {
      const rest = new REST().setToken(token);
      // TODO command definitions
      let commands = {};
      await rest.put(Routes.applicationCommands(clientId), {
        body: {
          commands,
        },
      });

      await kvSet(this.db, 'discord:command_version', COMMAND_VERSION);
    }

    await this.client.login(token);

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      // lookup interaction.commandName in the commands map and run it
    });

    // TODO allow passing in the message handler
    // TODO run this in a root span and handle errors
    const handler = createThreadedConverationHandler();
    this.client.on('messageCreate', (message) => handler(this, message));
  }

  async sendChat(event: OutgoingChatEvent): Promise<void> {
    const info = await this.getConversationById(event.conversation_id);
    if (!info) {
      throw new Error(`No Discord channel ID found for conversation ${event.conversation_id}`);
    }

    let channel = (await this.client.channels.fetch(info.channel)) as TextChannel | null;
    if (!channel) {
      throw new Error(`Discord channel for conversation ${event.conversation_id} does not exist`);
    }

    await channel.send(event.message);
  }
}
