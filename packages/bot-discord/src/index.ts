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
  IncomingEventCallback,
  IncomingEvent,
  postgresClient,
  conversations,
} from '@ramus/bot';
import { LRUCache } from 'lru-cache';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { kvConfigs } from '@ramus/bot';
import { channels, guildOrganizations, guildUsers } from './db.js';
import { kvGet } from '@ramus/bot';
import { kvSet } from '@ramus/bot';
import { PgTransaction } from 'drizzle-orm/pg-core';

interface DiscordConversation {
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
    const currentCommandVersion: number = (await kvGet('discord:command_version')) ?? 0;

    if (currentCommandVersion < COMMAND_VERSION) {
      const rest = new REST().setToken(token);
      // TODO take commands with the constructor
      let commands = {};
      await rest.put(Routes.applicationCommands(clientId), {
        body: {
          commands,
        },
      });

      await kvSet('discord:command_version', COMMAND_VERSION);
    }

    await this.client.login(token);

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      // lookup interaction.commandName in the commands map and run it
    });

    // TODO run this in a root span and handle errors
    this.client.on('messageCreate', (message) => this.handleMessage(message));

    // TODO check for command version, update commands if needed
  }

  async handleMessage(message: Message) {
    let conversation = await this.getConversationForChannel(message.channelId);
    const mentionedBot = this.client.user && message.mentions.users.has(this.client.user.id);

    const { guildId } = message;
    if (!guildId) {
      // Ignore DMs for now
      return;
    }

    // TODO figure out how to make all this logic platform-independent but that can come later.
    if (conversation?.active === false) {
      // This conversation is inactive, so ignore it unless the bot was specifically mentioned.
      if (mentionedBot) {
        // Mentioning the bot in an inactive conversation sets it active again.
        await this.manager.setConversationActive(this.db, conversation.conversation_id, true);

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

      let [org, user] = await Promise.all([
        this.db
          .select({ organization_id: guildOrganizations.organization_id })
          .from(guildOrganizations)
          .where(eq(guildOrganizations.discord_guild_id, message.guildId!)),
        this.db
          .select({ user_id: guildUsers.user_id })
          .from(guildUsers)
          .where(
            and(
              eq(guildUsers.discord_user_id, message.author.id),
              eq(guildUsers.discord_guild_id, guildId)
            )
          ),
      ]);

      if (!org[0]) {
        // TODO return an ephemeral message about how the org is not set up
        throw new Error(`No organization found for guild ${message.guildId}`);
      }

      if (!user[0]) {
        // TODO return an ephemeral message about how the user is not set up with instructions on
        // how to authenticate using a slash command
        throw new Error(
          `No user found for user ${message.author.displayName} (${message.author.globalName}: ${message.author.id})`
        );
      }

      conversation = await this.db.transaction(async (tx) => {
        // TODO run this and the next query in a transaction
        const conversationId = await this.manager.newConversation(
          tx,
          this.name,
          org[0].organization_id,
          user[0].user_id
        );

        await tx.insert(channels).values({
          channel: channelId,
          conversation_id: conversationId,
          guild: guildId,
          started_by: message.author.id,
          started_at: new Date(),
        });

        let conversation = {
          conversation_id: conversationId,
          guild: message.guildId!,
          channel: channelId,
          started_by: message.author.id,
          active: true,
          org: org[0].organization_id,
        };

        this.populateCache(conversation.conversation_id, conversation.channel, conversation);
        return conversation;
      });
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
