import { ChannelType, Client, Events, IntentsBitField, Message, TextChannel } from 'discord.js';
import {
  BotManager,
  BotAdapter,
  OutgoingEvent,
  OutgoingChatEvent,
  IncomingEventCallback,
  IncomingEvent,
  postgresClient,
} from '@ramus/bot';
import { LRUCache } from 'lru-cache';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { channels } from './db.js';

interface DiscordConversation {
  conversation_id: string;
  guild: string;
  channel: string;
  active: boolean;
}

const COMMAND_VERSION = 0;

export class DiscordBotAdapter implements BotAdapter {
  name = 'discord';

  client: Client;
  manager: BotManager;

  conversationsById: LRUCache<string, DiscordConversation | false>;
  conversationsByChannel: LRUCache<string, DiscordConversation | false>;

  db: PostgresJsDatabase;

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

  async getConversationById(id: string): Promise<DiscordConversation | null> {
    let conversation = this.conversationsById.get(id);
    if (conversation != null) {
      return conversation || null;
    }

    conversation = (
      await this.db.select().from(channels).where(eq(channels.conversation_id, id))
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
      (await this.db.select().from(channels).where(eq(channels.channel, channel)))[0] ?? null;

    this.populateCache(info?.conversation_id, channel, info);

    return info;
  }

  async connect(token: string) {
    await this.client.login(token);

    this.client.on('messageCreate', (message) => this.handleMessage(message));

    // TODO check for command version, update commands if needed
  }

  async setConversationActive(conversationId: string, active: boolean) {
    await this.db
      .update(channels)
      .set({ active })
      .where(and(eq(channels.conversation_id, conversationId), eq(channels.active, false)));
  }

  async handleMessage(message: Message) {
    let conversation = await this.getConversationForChannel(message.channelId);
    const mentionedBot = this.client.user && message.mentions.users.has(this.client.user.id);

    if (!message.guildId) {
      // Ignore DMs for now
      return;
    }

    // TODO figure out how to make all this logic platform-independent but that can come later.
    if (conversation?.active === false) {
      // This conversation is inactive, so ignore it unless the bot was specifically mentioned.
      if (mentionedBot) {
        // Mentioning the bot in an inactive conversation sets it active again.
        await this.setConversationActive(conversation.conversation_id, true);

        this.receiveEvent({
          conversation_id: conversation.conversation_id,
          id: message.id,
          type: 'reopen',
        });

        conversation.active = true;
      } else {
        // Bot not mentioned, so ignore it.
        return;
      }
    }

    let channelId = message.channelId;
    if (!conversation) {
      if (mentionedBot && message.channel.type === ChannelType.GuildText) {
        // TODO better logic for a thread name. Move this to the global platform and make it use some kind of summary
        const threadName = `${message.author.displayName}: ${message.content.slice(0, 50)}`;
        const thread = await message.channel.threads.create({
          name: threadName,
        });
        channelId = thread.id;
      }

      conversation = {
        conversation_id: this.manager.newConversationId(),
        active: true,
        guild: message.guildId!,
        channel: channelId,
      };

      this.populateCache(conversation.conversation_id, conversation.channel, conversation);
    }

    // TODO Maybe want some logic to make sure that the person typing is the thread originator. Not important right now
    // though.

    this.receiveEvent({
      conversation_id: conversation.conversation_id,
      id: message.id,
      message: message.content,
      type: 'chat',
    });
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
