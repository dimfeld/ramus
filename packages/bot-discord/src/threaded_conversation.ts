import { ChannelType, Message, ThreadAutoArchiveDuration } from 'discord.js';
import { DiscordBotAdapter } from './index.js';
import { channels, guildOrganizations, guildUsers } from './db.js';
import { and, eq } from 'drizzle-orm';

export interface HandleThreadedConversationConfig {
  /** Customize the type of thread created from a channel. */
  threadType?: ChannelType.PublicThread | ChannelType.PrivateThread;
  newThreadName?: (message: Message) => string | Promise<string>;
  autoArchiveDuration?: ThreadAutoArchiveDuration | null;
  // /** The message to give to users who aren't linked to an internal user, or null
  // to ignore them. */
  // unknownUserMessage?: string | null;
  // /** The message to give when calling the bot from an unlinked organization, or null
  // to ignore it. */
  // unknownOrgMessage?: string | null;
}

export function createThreadedConverationHandler(config: HandleThreadedConversationConfig = {}) {
  let resolvedConfig = {
    threadType: ChannelType.PublicThread as const,
    newThreadName: (message: Message) =>
      `${message.author.displayName}: ${message.content.slice(0, 50)}`,
    autoArchiveDuration: null,
    ...config,
  };

  return (platform: DiscordBotAdapter, message: Message) =>
    handleThreadedConversation(resolvedConfig, platform, message);
}

/** Create a thread each time the bot is mentioned from a main channel. */
export async function handleThreadedConversation(
  config: Required<HandleThreadedConversationConfig>,
  platform: DiscordBotAdapter,
  message: Message
) {
  let conversation = await platform.getConversationForChannel(message.channelId);
  const mentionedBot = platform.client.user && message.mentions.users.has(platform.client.user.id);

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
      await platform.receiveEvent({
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
      // The bot was mentioned in a normal channel, so create a thread from that message.
      // TODO better logic for a thread name. Move this to the global platform and
      // make it use some kind of summary and/or customizable
      const threadName = await config.newThreadName(message);
      const thread = await message.channel.threads.create({
        name: threadName,
        startMessage: message,
        type: config.threadType,
        autoArchiveDuration: config.autoArchiveDuration ?? undefined,
      });
      channelId = thread.id;
    }

    let [org, user] = await Promise.all([
      platform.db
        .select({ organization_id: guildOrganizations.organization_id })
        .from(guildOrganizations)
        .where(eq(guildOrganizations.discord_guild_id, message.guildId!)),
      platform.db
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

    conversation = await platform.db.transaction(async (tx) => {
      // TODO run this and the next query in a transaction
      const conversationId = await platform.manager.newConversation(
        tx,
        platform.name,
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

      platform.populateCache(conversation.conversation_id, conversation.channel, conversation);
      return conversation;
    });
  }

  // TODO Maybe want some logic to make sure that the person typing is the thread originator. Not important right now
  // though.

  platform.receiveEvent({
    conversation_id: conversation.conversation_id,
    id: message.id,
    message: message.content,
    type: 'chat',
  });
}
