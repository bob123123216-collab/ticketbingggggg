// Your first Yapper bot. Needs Node 18+ (https://nodejs.org) and yapper.js next to this file.
//   1. Save yapper.js from https://www.yapper.website/sdk/yapper.js into the same folder.
//   2. Put your token below (Settings → Developer → Create).
//   3. Add the bot to a server you manage (same place), then run:  node bot.js
import { Bot } from './yapper.js';

const bot = new Bot(process.env.YAPPER_BOT_TOKEN || 'PASTE_YOUR_TOKEN_HERE');

// /ping → pong. Shows up in the "/" menu for everyone in the server.
bot.command('ping', 'Is the bot alive?', (msg) => msg.reply('pong 🏓'));

// /roll 20 → a dice roll.
bot.command('roll', 'Roll a die, like /roll 20', (msg) => {
  const sides = Math.max(2, Math.min(1000, Number(msg.argv[0]) || 6));
  msg.reply(`🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})`);
});

// Any message that @mentions the bot.
bot.on('message', (msg) => {
  if (msg.mentioned) msg.reply(`hey ${msg.authorMention}, try /ping`);
});

// Someone joined one of the bot's servers.
bot.on('member_join', async (ev) => {
  const channels = await bot.channels(ev.server_id);
  const general = channels.find((c) => c.kind === 'text' && /general|welcome|chat/i.test(c.name)) || channels.find((c) => c.kind === 'text');
  if (general) bot.send(general.id, `welcome <@${ev.user_id}>! you're member #${ev.member_count}`);
});

// Give the bot a picture once (a PNG/JPG next to this file). Uncomment to use:
// bot.setAvatar('./avatar.png');

bot.start().catch((e) => {
  console.error('[yapper] could not start:', e.message);
  process.exit(1);
});
