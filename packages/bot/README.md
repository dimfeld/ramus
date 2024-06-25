# Ramus Bot

This is an platform-independent abstraction over chatbot platforms, which handles threading and sending messages between the chat
platform and the user. An adapter system allows Ramus Bot to be used with any chat product or similar platform.

Currently supported platforms

- Discord


## Using Ramus Bot

Ramus has a simple event-based system, where each event contains the associated conversation ID. The specifics of
routing the event and responding to it are left to your application.

```typescript
let bot = new BotManager();

let migrations = [bot.migrations(), discord.migrations()];

initDb({
  connectionString: process.env.DATABASE_URL,
  migrations,
  // a Drizzle instance for any PostgreSQL driver.
  db, 
});

let discord = new DiscordBotAdapter(bot);
bot.registerAdapter(discord);

await discord.connect(env.DISCORD_CLIENT_ID, env.DISCORD_BOT_TOKEN);


bot.on('event', (e) => {
  if(e.type === 'chat') {
    bot.sendEvent({
      conversation_id: e.conversation_id,
      id: randomUUID(),
      type: 'chat',
      message: `I agree with ${e.message}`
    })
  }
});
```

