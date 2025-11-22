/**
 * app.js
 * Discord Giveaway Bot + minimal web UI backend (Express).
 *
 * Environment variables required:
 *  - DISCORD_TOKEN
 *  - RANDOMORG_API_KEY
 *  - PORT (optional, default 3000)
 *
 * NOTE: This is a starting implementation. Tune validations, error handling,
 * database persistence, rate-limits, and security for production.
 */

import fs from "fs-extra";
import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ComponentType,
  EmbedBuilder,
  PermissionsBitField
} from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config / Data files ----------
const DATA_DIR = path.join(__dirname, "data");
await fs.ensureDir(DATA_DIR);
const GIVE_FILE = path.join(DATA_DIR, "giveaways.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// default config if not exists
const defaultConfig = {
  pot: 1000, // pot in "c" units (coins). 1c = conversionRate USD (configurable)
  conversionRateUSDPerC: 0.6,
  houseEdge: 0.02,
  riskProfiles: {
    low: { potSharePercent: 30 },   // give 30% of pot to winner if choose low risk
    high: { potSharePercent: 70 }   // give 70% if high risk
  }
};

if (!(await fs.pathExists(CONFIG_FILE))) {
  await fs.writeJson(CONFIG_FILE, defaultConfig, { spaces: 2 });
}
if (!(await fs.pathExists(GIVE_FILE))) {
  await fs.writeJson(GIVE_FILE, { giveaways: [] }, { spaces: 2 });
}

// helper to read/write
const readData = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeData = async (file, obj) => await fs.writeFile(file, JSON.stringify(obj, null, 2));

// ---------- Random.org helper ----------
const RANDOMORG_API_KEY = process.env.RANDOMORG_API_KEY;
if (!RANDOMORG_API_KEY) {
  console.warn("Warning: RANDOMORG_API_KEY not set. Random.org requests will fail.");
}

async function randomOrgInteger(min = 0, max = 100) {
  if (!RANDOMORG_API_KEY) throw new Error("No RANDOMORG_API_KEY");
  // Random.org JSON-RPC endpoint
  const body = {
    jsonrpc: "2.0",
    method: "generateIntegers",
    params: {
      apiKey: RANDOMORG_API_KEY,
      n: 1,
      min,
      max,
      replacement: true
    },
    id: Date.now()
  };
  const res = await fetch("https://api.random.org/json-rpc/4/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (j.error) throw new Error("Random.org error: " + JSON.stringify(j.error));
  return j.result.random.data[0];
}

// ---------- Discord client ----------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN missing - set environment variable");
  process.exit(1);
}

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ],
  partials: [ Partials.Channel ]
});

client.once(Events.ClientReady, () => {
  console.log("Discord client ready as", client.user.tag);
});

// Utility: save giveaway list
async function saveGiveaways(obj) {
  await writeData(GIVE_FILE, obj);
}
async function loadGiveaways() {
  return readData(GIVE_FILE);
}
async function loadConfig() {
  return readData(CONFIG_FILE);
}
async function saveConfig(cfg) {
  return writeData(CONFIG_FILE, cfg);
}

// Create giveaway embed + Join button
function buildGiveawayEmbed(g) {
  return new EmbedBuilder()
    .setTitle(g.title || "🎉 Giveaway")
    .setDescription(`Prize: ${g.prize || "Unknown"}\nPot: ${g.pot}c\nEnds: <t:${Math.floor(g.endsAt/1000)}:R>`)
    .setFooter({ text: `Giveaway ID: ${g.id}` });
}

// Button customIds must be unique-ish per giveaway
function joinButtonId(gid) { return `join:${gid}` }
function forceEndButtonId(gid) { return `forceend:${gid}` }

// When giveaway ends: determine winner(s)
async function resolveGiveaway(gid) {
  const data = await loadGiveaways();
  const g = data.giveaways.find(x => x.id === gid);
  if (!g || g.ended) return;
  g.ended = true;
  // request random.org roll 0-100
  let roll;
  try {
    roll = await randomOrgInteger(0, 100);
  } catch (e) {
    console.error("Random.org roll failed:", e);
    g.result = { error: "random.org failed", message: e.message };
    await saveGiveaways(data);
    // update message to indicate error
    try {
      const ch = await client.channels.fetch(g.channelId);
      const msg = await ch.messages.fetch(g.messageId);
      await msg.edit({ content: "⚠️ Error when resolving giveaway: random.org failed.", embeds: [buildGiveawayEmbed(g)] });
    } catch(e){}
    return;
  }

  g.roll = roll;
  // Evaluate winners: criteria: entry chose under/over and match condition:
  // under: roll <= main ; over: roll >= main
  const winnersCandidates = g.entries.filter(entry => {
    if (entry.choice === "under") return roll <= entry.main;
    if (entry.choice === "over") return roll >= entry.main;
    return false;
  });

  // If none, no winners
  if (winnersCandidates.length === 0) {
    g.winner = null;
    g.result = { roll, note: "No winners" };
    await saveGiveaways(data);
    // Notify channel
    try {
      const ch = await client.channels.fetch(g.channelId);
      const msg = await ch.messages.fetch(g.messageId);
      const embed = buildGiveawayEmbed(g).setDescription(`${buildGiveawayEmbed(g).data.description}\n\nResult roll: **${roll}**\nNo winners this round.`);
      await msg.edit({ embeds: [embed], components: [] });
    } catch(e){}
    return;
  }

  // If multiple winners: handle duplicates by main (tiebreak among identical mains)
  // Step 1: group winners by main
  const grouped = {};
  for (const w of winnersCandidates) {
    grouped[w.main] = grouped[w.main] || [];
    grouped[w.main].push(w);
  }

  // For any group with >1, choose by higher tiebreak; if tiebreak equal then request random.org
  const resolved = [];
  for (const key of Object.keys(grouped)) {
    const arr = grouped[key];
    if (arr.length === 1) { resolved.push(arr[0]); continue; }
    // find highest tiebreak
    arr.sort((a,b) => b.tiebreak - a.tiebreak);
    const top = arr[0];
    // if tie on tiebreak
    const tiedTop = arr.filter(e => e.tiebreak === top.tiebreak);
    if (tiedTop.length === 1) {
      resolved.push(top);
    } else {
      // request random.org for tiebreak between tiedTop indexes
      try {
        const r = await randomOrgInteger(0, tiedTop.length - 1);
        resolved.push(tiedTop[r]);
      } catch(e) {
        // fallback: pick first
        resolved.push(tiedTop[0]);
      }
    }
  }

  // Now resolved may still contain >1 (because winners with different main values). Pick one randomly via random.org
  let finalWinner;
  if (resolved.length === 1) finalWinner = resolved[0];
  else {
    try {
      const idx = await randomOrgInteger(0, resolved.length - 1);
      finalWinner = resolved[idx];
    } catch(e) {
      finalWinner = resolved[0];
    }
  }

  // Payout calculation:
  // probability:
  //  - under: P = (main + 1) / 101
  //  - over: P = (101 - main) / 101
  const cfg = await loadConfig();
  const houseEdge = cfg.houseEdge ?? 0.02;
  const main = finalWinner.main;
  let prob;
  if (finalWinner.choice === "under") prob = (finalWinner.main + 1) / 101;
  else prob = (101 - finalWinner.main) / 101;
  if (prob <= 0) prob = 1/101;
  const multiplier = (1 / prob) * (1 - houseEdge);
  // stake in c units
  const stake = (finalWinner.stakeC ?? 1);
  const baseWin = Math.floor(stake * multiplier * 100) / 100; // rounding to 2 decimals of c (we keep c unit)
  // pot share by chosen risk profile
  const profile = cfg.riskProfiles[finalWinner.riskProfile] ?? cfg.riskProfiles["low"];
  const potSharePercent = profile?.potSharePercent ?? 0;
  const potShareAmount = Math.floor(g.pot * (potSharePercent / 100));
  // final payout (in c)
  const finalPayoutC = baseWin + potShareAmount;

  // update pot
  g.pot = Math.max(0, g.pot - potShareAmount);

  g.winner = {
    userId: finalWinner.userId,
    username: finalWinner.username,
    main: finalWinner.main,
    tiebreak: finalWinner.tiebreak,
    choice: finalWinner.choice,
    stake: stake,
    payoutC: finalPayoutC,
    baseWinC: baseWin,
    potShareC: potShareAmount
  };
  g.result = { roll, resolvedCount: resolved.length };

  await saveGiveaways(data);

  // Edit message to announce winner, and add Double Down buttons (Yes/No)
  try {
    const ch = await client.channels.fetch(g.channelId);
    const msg = await ch.messages.fetch(g.messageId);

    const embed = new EmbedBuilder()
      .setTitle("🎉 Giveaway Result")
      .setDescription(`Roll: **${roll}**\nWinner: <@${finalWinner.userId}> (${finalWinner.username})\nPayout: **${finalPayoutC}c** (${(finalPayoutC * cfg.conversionRateUSDPerC).toFixed(2)}$)\n\nBase win: ${baseWin}c\nPot share: ${potShareAmount}c`)
      .setFooter({ text: "Double Down? (6 hours to respond)" });

    const yes = new ButtonBuilder().setCustomId(`dd_yes:${g.id}:${finalWinner.userId}`).setLabel("Yes").setStyle(ButtonStyle.Success);
    const no  = new ButtonBuilder().setCustomId(`dd_no:${g.id}:${finalWinner.userId}`).setLabel("No").setStyle(ButtonStyle.Danger);

    await msg.edit({ embeds: [embed], components: [ new ActionRowBuilder().addComponents(yes, no) ] });

    // schedule auto-select No after 6 hours unless someone clicks
    finalWinner.doubleDownDeadline = Date.now() + 6*60*60*1000; // 6h in ms
    g.doubleDown = { state: "pending", deadline: finalWinner.doubleDownDeadline, winnerId: finalWinner.userId };
    await saveGiveaways(data);

    setTimeout(async () => {
      const ddata = await loadGiveaways();
      const gg = ddata.giveaways.find(x => x.id === g.id);
      if (!gg) return;
      if (gg.doubleDown && gg.doubleDown.state === "pending") {
        // auto choose No
        gg.doubleDown.state = "no";
        await saveGiveaways(ddata);
        try {
          const ch2 = await client.channels.fetch(gg.channelId);
          const msg2 = await ch2.messages.fetch(gg.messageId);
          const embed2 = EmbedBuilder.from(msg2.embeds[0]).setFooter({ text: "Double Down: No (auto)" });
          await msg2.edit({ embeds: [embed2], components: [] });
        } catch(e){}
      }
    }, 6*60*60*1000 + 5000); // 6 hours + small buffer

  } catch (e) {
    console.error("Failed announce winner:", e);
  }
}

// ---------- Discord interaction handlers ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const [action, gid, ...rest] = interaction.customId.split(":");
      if (action === "join") {
        // open modal to collect main, tiebreak, stake, choice, riskProfile
        const modal = new ModalBuilder()
          .setCustomId(`modal_join:${gid}`)
          .setTitle("Enter your numbers");

        const mainInput = new TextInputBuilder()
          .setCustomId("main")
          .setLabel("Main number (0-100)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 42");

        const tiebreakInput = new TextInputBuilder()
          .setCustomId("tiebreak")
          .setLabel("Tiebreak number (0-100)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 13");

        const stakeInput = new TextInputBuilder()
          .setCustomId("stake")
          .setLabel("Stake (in c) — optional")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("default 1");

        const choiceInput = new TextInputBuilder()
          .setCustomId("choice")
          .setLabel("Choice: under or over")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("under or over");

        const riskInput = new TextInputBuilder()
          .setCustomId("risk")
          .setLabel("Risk profile (low/high)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("low or high");

        modal.addComponents(
          new ActionRowBuilder().addComponents(mainInput),
          new ActionRowBuilder().addComponents(tiebreakInput),
          new ActionRowBuilder().addComponents(stakeInput),
          new ActionRowBuilder().addComponents(choiceInput),
          new ActionRowBuilder().addComponents(riskInput)
        );

        await interaction.showModal(modal);
      } else if (action === "forceend") {
        // Allow admins to force end
        const data = await loadGiveaways();
        const g = data.giveaways.find(x => x.id === gid);
        if (!g) {
          await interaction.reply({ content: "Giveaway not found", ephemeral: true });
          return;
        }
        // check permission: user must have ManageGuild or Administrator
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
          await interaction.reply({ content: "You don't have permission to force-end.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: "Force ending giveaway...", ephemeral: true });
        await resolveGiveaway(gid);
      } else if (action === "dd_yes" || action === "dd_no") {
        // Double Down buttons
        const [act,gid, winnerId] = interaction.customId.split(":");
        const data = await loadGiveaways();
        const g = data.giveaways.find(x => x.id === gid);
        if (!g || !g.winner) {
          await interaction.reply({ content: "Giveaway or winner not found.", ephemeral: true });
          return;
        }
        if (interaction.user.id !== winnerId) {
          await interaction.reply({ content: "Only the winner can respond to Double Down.", ephemeral: true });
          return;
        }
        if (!g.doubleDown || g.doubleDown.state !== "pending") {
          await interaction.reply({ content: "Double Down no longer available.", ephemeral: true });
          return;
        }
        if (act === "dd_no") {
          g.doubleDown.state = "no";
          await saveGiveaways(data);
          // update message
          try {
            const ch = await client.channels.fetch(g.channelId);
            const msg = await ch.messages.fetch(g.messageId);
            const embed = EmbedBuilder.from(msg.embeds[0]).setFooter({ text: "Double Down: No" });
            await msg.edit({ embeds: [embed], components: [] });
          } catch (e) {}
          await interaction.reply({ content: "Double Down declined. Congratulations!", ephemeral: true });
          return;
        } else {
          // yes: resolve double down by random roll (win threshold >=50)
          try {
            const r = await randomOrgInteger(0,100);
            if (r >= 50) {
              // win: add entire remaining pot to winner payout
              const cfg = await loadConfig();
              const add = g.pot;
              g.winner.payoutC += add;
              g.pot = 0;
              g.doubleDown.state = "yes_win";
              await saveGiveaways(data);
              try {
                const ch = await client.channels.fetch(g.channelId);
                const msg = await ch.messages.fetch(g.messageId);
                const embed = EmbedBuilder.from(msg.embeds[0])
                  .setDescription(`${msg.embeds[0].data.description}\n\nDouble Down result: **WIN** (rolled ${r}). Added ${add}c from pot.`)
                  .setFooter({ text: "Double Down: Win" });
                await msg.edit({ embeds: [embed], components: [] });
              } catch(e){}
              await interaction.reply({ content: `Double Down WIN! added ${add}c to your payout.`, ephemeral: true });
            } else {
              // lose: return the winner's payout base to the pot (we subtract baseWinC)
              const ret = Math.max(0, Math.floor(g.winner.baseWinC));
              g.pot += ret;
              g.winner.payoutC = Math.max(0, g.winner.payoutC - ret);
              g.doubleDown.state = "yes_lose";
              await saveGiveaways(data);
              try {
                const ch = await client.channels.fetch(g.channelId);
                const msg = await ch.messages.fetch(g.messageId);
                const embed = EmbedBuilder.from(msg.embeds[0])
                  .setDescription(`${msg.embeds[0].data.description}\n\nDouble Down result: **LOSE** (rolled ${r}). Returned ${ret}c to pot.`)
                  .setFooter({ text: "Double Down: Lose" });
                await msg.edit({ embeds: [embed], components: [] });
              } catch(e){}
              await interaction.reply({ content: `Double Down LOSE. Returned ${ret}c to the pot.`, ephemeral: true });
            }
          } catch (e) {
            await interaction.reply({ content: "Random.org failed for Double Down.", ephemeral: true });
          }
        }
      }
    } else if (interaction.isModalSubmit()) {
      const [prefix, gid] = interaction.customId.split(":");
      if (prefix === "modal_join") {
        const main = parseInt(interaction.fields.getTextInputValue("main"));
        const tiebreak = parseInt(interaction.fields.getTextInputValue("tiebreak"));
        const stake = parseFloat(interaction.fields.getTextInputValue("stake") || "1");
        const choice = interaction.fields.getTextInputValue("choice").toLowerCase();
        const risk = interaction.fields.getTextInputValue("risk").toLowerCase();

        // validate
        if (isNaN(main) || main < 0 || main > 100) {
          await interaction.reply({ content: "Invalid main number. Must be 0-100.", ephemeral: true });
          return;
        }
        if (isNaN(tiebreak) || tiebreak < 0 || tiebreak > 100) {
          await interaction.reply({ content: "Invalid tiebreak number. Must be 0-100.", ephemeral: true });
          return;
        }
        if (!["under","over"].includes(choice)) {
          await interaction.reply({ content: "Choice must be 'under' or 'over'.", ephemeral: true });
          return;
        }
        if (!["low","high"].includes(risk)) {
          await interaction.reply({ content: "Risk must be 'low' or 'high'.", ephemeral: true });
          return;
        }

        const data = await loadGiveaways();
        const g = data.giveaways.find(x => x.id === gid);
        if (!g) {
          await interaction.reply({ content: "Giveaway not found.", ephemeral: true });
          return;
        }
        if (g.ended) {
          await interaction.reply({ content: "Giveaway already ended.", ephemeral: true });
          return;
        }

        // Save entry
        const already = g.entries.find(e => e.userId === interaction.user.id);
        // allow multiple entries per user? We'll allow multiple; it's an entry model
        g.entries.push({
          entryId: `${interaction.user.id}-${Date.now()}`,
          userId: interaction.user.id,
          username: `${interaction.user.username}#${interaction.user.discriminator}`,
          main,
          tiebreak,
          stakeC: stake,
          choice,
          riskProfile: risk,
          joinedAt: Date.now()
        });

        await saveGiveaways(data);
        await interaction.reply({ content: `Joined giveaway with main=${main}, tiebreak=${tiebreak}, choice=${choice}, stake=${stake}c, risk=${risk}`, ephemeral: true });

        // update embed counts
        try {
          const ch = await client.channels.fetch(g.channelId);
          const msg = await ch.messages.fetch(g.messageId);
          const embed = buildGiveawayEmbed(g).setDescription(`Prize: ${g.prize}\nPot: ${g.pot}c\nEntries: ${g.entries.length}\nEnds: <t:${Math.floor(g.endsAt/1000)}:R>`);
          await msg.edit({ embeds: [embed] });
        } catch(e) {}
      }
    }
  } catch (e) {
    console.error("Interaction handler error:", e);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  if (content.startsWith("$start")) {
    // Usage: $start <durationSeconds> | optional create via command for quick test.
    const parts = content.split(/\s+/);
    const duration = parseInt(parts[1] || "60"); // seconds
    const prize = parts.slice(2).join(" ") || "Test Prize";
    const data = await loadGiveaways();

    const id = `G-${Date.now()}`;
    const now = Date.now();
    const g = {
      id,
      title: prize,
      prize,
      creatorId: message.author.id,
      channelId: message.channel.id,
      messageId: null,
      createdAt: now,
      endsAt: now + duration*1000,
      entries: [],
      pot: (await loadConfig()).pot,
      ended: false
    };
    data.giveaways.push(g);
    await saveGiveaways(data);

    // send message with Join button
    const embed = buildGiveawayEmbed(g).setDescription(`Prize: ${g.prize}\nPot: ${g.pot}c\nEntries: 0\nEnds: <t:${Math.floor(g.endsAt/1000)}:R>`);
    const joinBtn = new ButtonBuilder().setCustomId(joinButtonId(id)).setLabel("Join").setStyle(ButtonStyle.Primary);
    const forceBtn = new ButtonBuilder().setCustomId(forceEndButtonId(id)).setLabel("Force End").setStyle(ButtonStyle.Danger);
    const msg = await message.channel.send({ embeds: [embed], components: [ new ActionRowBuilder().addComponents(joinBtn, forceBtn) ] });

    // save messageId
    g.messageId = msg.id;
    await saveGiveaways(data);

    // schedule end
    setTimeout(() => resolveGiveaway(id), duration*1000);
    await message.reply(`Started giveaway ${id}, ends in ${duration}s`);
  }
});

// login
client.login(DISCORD_TOKEN).catch(err => {
  console.error("Discord login failed:", err);
  process.exit(1);
});

// ---------- Express web server for simple UI / config ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// get config
app.get("/api/config", async (req, res) => {
  const cfg = await loadConfig();
  res.json(cfg);
});
app.post("/api/config", async (req, res) => {
  const incoming = req.body;
  const cfg = await loadConfig();
  const merged = { ...cfg, ...incoming };
  await saveConfig(merged);
  res.json({ ok: true, config: merged });
});

// list giveaways
app.get("/api/giveaways", async (req, res) => {
  const data = await loadGiveaways();
  res.json(data);
});

// create giveaway from web UI (channelId required)
app.post("/api/create", async (req, res) => {
  const { channelId, durationSec = 60, prize = "Prize from UI" } = req.body;
  if (!channelId) return res.status(400).json({ error: "channelId required" });
  const data = await loadGiveaways();
  const id = `G-${Date.now()}`;
  const now = Date.now();
  const cfg = await loadConfig();
  const g = {
    id,
    title: prize,
    prize,
    creatorId: "web-ui",
    channelId,
    messageId: null,
    createdAt: now,
    endsAt: now + durationSec*1000,
    entries: [],
    pot: cfg.pot,
    ended: false
  };
  data.giveaways.push(g);
  await saveGiveaways(data);

  // Post to channel using bot (if bot is in that guild & channel)
  try {
    const ch = await client.channels.fetch(channelId);
    const embed = buildGiveawayEmbed(g).setDescription(`Prize: ${g.prize}\nPot: ${g.pot}c\nEntries: 0\nEnds: <t:${Math.floor(g.endsAt/1000)}:R>`);
    const joinBtn = new ButtonBuilder().setCustomId(joinButtonId(id)).setLabel("Join").setStyle(ButtonStyle.Primary);
    const forceBtn = new ButtonBuilder().setCustomId(forceEndButtonId(id)).setLabel("Force End").setStyle(ButtonStyle.Danger);
    const msg = await ch.send({ embeds: [embed], components: [ new ActionRowBuilder().addComponents(joinBtn, forceBtn) ] });
    g.messageId = msg.id;
    await saveGiveaways(data);
    // schedule resolution
    setTimeout(() => resolveGiveaway(id), durationSec*1000);
    res.json({ ok: true, id });
  } catch (e) {
    console.error("Failed to post to channel:", e);
    res.status(500).json({ error: "Failed to post to channel. Bot may not be in guild or channelId invalid." });
  }
});

app.listen(PORT, () => {
  console.log(`Web UI running at http://localhost:${PORT}`);
});
