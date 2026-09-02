require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// Token và Cấu hình Admin
const TOKEN = process.env.DISCORD_TOKEN || 'MTU0MjIyNDE2NzEx40380583.GWaVZb.EfY6qg0n11bkA3ehEMDOfHB8V_5Z13_Foa2osw';
const OWNER_ID = process.env.OWNER_ID || '1542224167116480583';
const ADMIN_USERNAME = 'tdstorevn01';

const PREFIX = ".";
const DB_FILE = path.join(__dirname, "data", "db.json");
const ADMIN_START_TD = 1000000000000000000n; // 1.000.000.000 tỷ TDĐ
const TX_WINDOW_MS = 35_000;
const TX_HISTORY_LIMIT = 30;

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { admins: [], users: {}, settings: {}, redeemedCodes: {} };
  }
}

let db = loadDB();
if (!db.admins) db.admins = [];
if (!db.users) db.users = {};
if (!db.settings) db.settings = {};
if (!db.redeemedCodes) db.redeemedCodes = {};

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function userData(id) {
  if (!db.users[id]) {
    db.users[id] = {
      td: "1000",
      coins: "1000",
      realm: 0,
      exp: 0,
      attack: 10,
      defense: 10,
      hp: 100,
      lastDaily: 0
    };
  }
  const u = db.users[id];
  if (u.td == null) u.td = u.coins ?? "1000";
  if (u.coins == null) u.coins = u.td;
  return u;
}

function tdValue(u) {
  try { return BigInt(String(u.td ?? u.coins ?? "0")); }
  catch { u.td = "0"; u.coins = "0"; return 0n; }
}

function setTD(u, value) {
  const n = BigInt(value);
  const safe = n < 0n ? 0n : n;
  u.td = safe.toString();
  u.coins = u.td;
}

function addTD(u, amount) {
  setTD(u, tdValue(u) + BigInt(amount));
}

function canAfford(u, amount) {
  return tdValue(u) >= BigInt(amount);
}

function money(n) {
  return BigInt(String(n)).toLocaleString("vi-VN");
}

function ensureAdminWallet(id) {
  const u = userData(id);
  if (id === OWNER_ID || db.admins.includes(id)) {
    if (tdValue(u) < ADMIN_START_TD) setTD(u, ADMIN_START_TD);
  }
  return u;
}

function isAdmin(message) {
  return message.author.id === OWNER_ID || 
         db.admins.includes(message.author.id) || 
         message.author.username === ADMIN_USERNAME;
}

function isOwner(message) {
  return message.author.id === OWNER_ID || message.author.username === ADMIN_USERNAME;
}

function mentionTarget(message) {
  return message.mentions.members.first();
}

function cleanMentionText(message, args) {
  return args.filter(x => !/^<@!?(\d+)>$/.test(x)).join(" ").trim();
}

function parseDuration(s) {
  if (!s) return null;
  const m = /^(\d+)(s|p|m|h|d)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, p: 60000, m: 60000, h: 3600000, d: 86400000 }[unit];
  const ms = n * mult;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 28 * 86400000) return null;
  return ms;
}

function rollDice() {
  return [1, 2, 3].map(() => Math.floor(Math.random() * 6) + 1);
}

function txResult(dice) {
  const sum = dice.reduce((a, b) => a + b, 0);
  return { sum, type: sum >= 11 ? "TÀI" : "XỈU" };
}

function diceEmoji(n) {
  return ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][n - 1];
}

function diceLine(dice) {
  return dice.map(diceEmoji).join("  ");
}

function allowedGameChannel(message) {
  if (!message.guild) return true;
  const channelId = db.settings[message.guild.id]?.gameChannelId;
  if (!channelId) return true;
  return message.channelId === channelId;
}

function gameChannelLabel(message) {
  const channelId = db.settings[message.guild.id]?.gameChannelId;
  return channelId ? `<#${channelId}>` : "chưa giới hạn";
}

// ===================== TÀI XỈU =====================
const txRounds = new Map();

function txKey(message) {
  return `${message.guildId}:${message.channelId}`;
}

function txHistory(guildId, channelId) {
  const s = db.settings[guildId] ||= {};
  s.txHistory ||= {};
  s.txHistory[channelId] ||= [];
  return s.txHistory[channelId];
}

function txHistoryText(message) {
  const history = txHistory(message.guildId, message.channelId);
  if (!history.length) return "Chưa có kết quả.";
  return history.slice(-20).map((x, i) => `${i + 1}. ${x.type} (${x.sum})`).join("\n");
}

function forcedTxType(message) {
  const s = db.settings[message.guildId];
  const type = s?.txForcedType;
  if (type === "tai" || type === "xiu") return type;
  return null;
}

function forcedDiceForType(type) {
  if (type === "tai") return [6, 5, 2];
  return [1, 2, 3];
}

async function openTxRound(message, key) {
  const round = txRounds.get(key);
  if (!round || round.opened) return;
  round.opened = true;

  const forced = forcedTxType(message);
  const dice = forced ? forcedDiceForType(forced) : rollDice();
  const result = txResult(dice);
  if (forced) {
    db.settings[message.guildId].txForcedType = null;
  }

  const history = txHistory(message.guildId, message.channelId);
  history.push({ type: result.type, sum: result.sum, dice, at: Date.now() });
  while (history.length > TX_HISTORY_LIMIT) history.shift();

  const lines = [];
  let totalPlayers = 0;
  let totalTD = 0n;

  for (const bet of round.bets.values()) {
    const u = userData(bet.userId);
    const win = bet.choice === (result.type === "TÀI" ? "tai" : "xiu");
    totalPlayers++;
    totalTD += BigInt(bet.amount);
    if (win) {
      addTD(u, BigInt(bet.amount) * 2n);
      lines.push(`🟢 <@${bet.userId}> thắng +${money(bet.amount)} TDĐ`);
    } else {
      lines.push(`🔴 <@${bet.userId}> thua -${money(bet.amount)} TDĐ`);
    }
  }

  saveDB();
  txRounds.delete(key);

  const forcedText = forced ? `\n🛡️ Admin override: **${forced === "tai" ? "TÀI" : "XỈU"}**` : "";
  await message.channel.send(
`🎲 **MỞ BÁT TÀI XỈU**
${diceLine(dice)}
🔢 Tổng điểm: **${result.sum}** → **${result.type}**${forcedText}
👥 Người chơi: **${totalPlayers}**
💰 Tổng tiền cược: **${money(totalTD)} TDĐ**
${lines.length ? lines.join("\n") : "Không có cược."}

📊 **CẦU GẦN NHẤT**
${txHistoryText(message)}`
  );
}

async function placeTxBet(message, amount, choice) {
  const key = txKey(message);
  let round = txRounds.get(key);
  if (!round) {
    round = {
      opened: false,
      createdAt: Date.now(),
      bets: new Map(),
      timer: null
    };
    txRounds.set(key, round);
    round.timer = setTimeout(() => openTxRound(message, key), TX_WINDOW_MS);
  }

  if (round.opened) return message.reply("⛔ Ván đã mở bát.");

  const u = userData(message.author.id);
  const oldBet = round.bets.get(message.author.id);
  const currentBet = oldBet ? BigInt(oldBet.amount) : 0n;
  const newTotal = currentBet + BigInt(amount);
  if (!canAfford(u, newTotal)) return message.reply("❌ Không đủ TDĐ cho tổng cược trong ván này.");

  if (oldBet) {
    setTD(u, tdValue(u) - BigInt(amount));
    oldBet.amount = newTotal.toString();
    oldBet.choice = choice;
  } else {
    setTD(u, tdValue(u) - BigInt(amount));
    round.bets.set(message.author.id, {
      userId: message.author.id,
      amount: BigInt(amount).toString(),
      choice
    });
  }
  saveDB();

  const left = Math.max(0, TX_WINDOW_MS - (Date.now() - round.createdAt));
  const sec = Math.ceil(left / 1000);
  return message.reply(
`🎲 Đã đặt **${money(amount)} TDĐ** vào **${choice === "tai" ? "TÀI" : "XỈU"}**.
⏱️ Còn khoảng **${sec}s** trước khi mở bát.
📝 Dùng ".tx <số TDĐ> <tài|xỉu>" để cộng thêm cược.`
  );
}

// ===================== NỐI TỪ =====================
const wordGames = new Map();

const VI_START = ["học sinh", "mặt trời", "bầu trời", "con mèo", "cây xanh", "tình bạn"];
const EN_START = ["hello world", "good morning", "blue sky", "school bus", "game night", "happy day"];

const VI_CHAIN = [
  ...VI_START,
  "sinh viên", "viên chức", "chức năng", "năng lượng", "lượng mưa", "mưa rào", "rào chắn",
  "trời xanh", "xanh lá", "lá cây", "cây cối", "cối xay", "xay bột", "bột mì",
  "mèo con", "con người", "người tốt", "tốt bụng", "bụng đói", "đói bụng",
  "bạn bè", "bè bạn", "bạn tốt", "tốt đẹp", "đẹp trai", "trai trẻ",
  "thành phố", "phố cổ", "cổ kính", "kính mắt", "mắt kính", "kính cận",
  "học tập", "tập trung", "trung tâm", "tâm lý", "lý do", "do dự", "dự án",
  "gia đình", "đình làng", "làng quê", "quê hương", "hương thơm", "thơm ngon"
];
const EN_CHAIN = [
  ...EN_START,
  "world cup", "cup cake", "cake shop", "shop owner", "owner name",
  "morning star", "star light", "light house", "house cat", "cat food",
  "sky blue", "blue bird", "bird house", "house party", "party game",
  "bus stop", "stop sign", "sign language", "language school", "school day",
  "night sky", "sky line", "line art", "art class", "class room",
  "happy day", "day time", "time zone", "zone map", "map maker"
];

function normalizeWord(s) {
  return s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function startWordGame(message, lang) {
  const key = `${message.guildId}:${message.channelId}`;
  const list = lang === "vi" ? VI_START : EN_START;
  const phrase = list[Math.floor(Math.random() * list.length)];
  wordGames.set(key, {
    lang,
    current: phrase,
    used: new Set([normalizeWord(phrase)]),
    turnUser: null
  });
  return phrase;
}

function chainList(lang) {
  return lang === "vi" ? VI_CHAIN : EN_CHAIN;
}

function hasUnusedContinuation(game, lastWord) {
  return chainList(game.lang).some(phrase => {
    const n = normalizeWord(phrase);
    return n.split(" ")[0] === lastWord && !game.used.has(n);
  });
}

async function checkWordGame(message) {
  const key = `${message.guildId}:${message.channelId}`;
  const game = wordGames.get(key);
  if (!game) return false;
  if (message.author.bot || message.content.startsWith(PREFIX)) return false;

  const text = message.content.trim();
  if (!text || text.length > 80) return false;

  const words = normalizeWord(text).split(" ").filter(Boolean);
  if (words.length < 2) {
    await message.reply("❌ Nối từ cần ít nhất 2 từ. Ví dụ: `sinh viên`.");
    return true;
  }

  const prev = normalizeWord(game.current).split(" ");
  const need = prev[prev.length - 1];
  const first = words[0];

  if (first !== need) {
    await message.reply(`❌ Sai. Phải bắt đầu bằng **${need}**.`);
    return true;
  }

  const normalized = normalizeWord(text);
  if (game.used.has(normalized)) {
    await message.reply("❌ Cụm từ này đã được dùng.");
    return true;
  }

  game.used.add(normalized);
  game.current = text;

  const u = userData(message.author.id);
  addTD(u, 1000n);

  const lastWord = words[words.length - 1];
  const deadEnd = !hasUnusedContinuation(game, lastWord);
  if (deadEnd) {
    addTD(u, 10000n);
    saveDB();
    wordGames.delete(key);
    await message.reply(
`✅ **${message.author.displayName}** nối đúng: **${text}**
💰 +1.000 TDĐ
🏁 **NGÕ CỤT!** Không còn từ hợp lệ trong từ điển bắt đầu bằng **${lastWord}**.
🏆 Người nối cuối nhận thêm **+10.000 TDĐ**.
💰 Tổng nhận lượt này: **+11.000 TDĐ**.`
    );
    return true;
  }

  saveDB();
  await message.reply(
`✅ **${message.author.displayName}** nối đúng: **${text}**
💰 +1.000 TDĐ
👉 Từ tiếp theo phải bắt đầu bằng **${lastWord}**.`
  );
  return true;
}

// ===================== TU TIÊN =====================
const REALMS = [
  { name: "Phàm Nhân", need: 0, bonus: 0 },
  { name: "Luyện Khí", need: 100, bonus: 10 },
  { name: "Trúc Cơ", need: 300, bonus: 25 },
  { name: "Kim Đan", need: 700, bonus: 50 },
  { name: "Nguyên Anh", need: 1500, bonus: 90 },
  { name: "Hóa Thần", need: 3000, bonus: 150 },
  { name: "Luyện Hư", need: 6000, bonus: 250 },
  { name: "Hợp Thể", need: 12000, bonus: 400 },
  { name: "Đại Thừa", need: 25000, bonus: 650 },
  { name: "Độ Kiếp", need: 50000, bonus: 1000 }
];

function promote(u) {
  let changed = false;
  while (u.realm + 1 < REALMS.length && u.exp >= REALMS[u.realm + 1].need) {
    u.realm++;
    const b = REALMS[u.realm].bonus;
    u.attack += 5 + Math.floor(b / 20);
    u.defense += 4 + Math.floor(b / 25);
    u.hp += 20 + Math.floor(b / 10);
    changed = true;
  }
  return changed;
}

// ===================== DISCORD CLIENT =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

client.once("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (message.author.id === OWNER_ID || db.admins.includes(message.author.id) || message.author.username === ADMIN_USERNAME) {
      ensureAdminWallet(message.author.id);
    }

    if (message.guild && await checkWordGame(message)) return;
    if (!message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    const gameCommands = new Set([
      "game", "tx", "cau", "bc", "nttv", "ntel", "ntstop",
      "tutien", "tu", "tuluyen", "tl", "tudanh",
      "tddaily"
    ]);
    if (gameCommands.has(cmd) && !allowedGameChannel(message)) {
      return message.reply(`⛔ Khu vực game chỉ hoạt động tại ${gameChannelLabel(message)}.`);
    }

    // ===== MENU =====
    if (cmd === "game") {
      return message.reply(
`🎮 **TRIDUNG GAME MENU**
\`.tx <TDĐ> <tai|xiu>\` — Tài Xỉu, mở bát sau 35 giây
\`.cau\` — Soi cầu Tài Xỉu
\`.bc <TDĐ> <bau|cua|tom|ca|nai|ga>\` — Bầu Cua
\`.nttv\` — Nối từ tiếng Việt
\`.ntel\` — Nối từ tiếng Anh

🌌 **TU TIÊN**
\`.tutien\` — Hồ sơ cảnh giới
\`.tuluyen\` — Tu luyện
\`.tudanh @user\` — Đấu tu tiên

💰 **TD ĐỒNG**
\`.tdcoin\` — Kiểm tra TDĐ
\`.tdcode <CODE>\` — Nhập mã thưởng
\`.tddaily\` — Daily +500 TDĐ

🛡️ **ADMIN**
\`.tdadmin @user\`
\`.tdunadmin @user\`
\`.tdaddcoin @user <TDĐ>\`
\`.tdsubcoin @user <TDĐ>\`
\`.tdban @user [lý do]\`
\`.tdmute @user 10m\`
\`.tdchannel #kenh\`
\`.adtdtai\` / \`.adtdxiu\` — Admin đặt kết quả ván kế tiếp

\`.ntstop\` — Dừng game nối từ`
      );
    }

    // ===== ADMIN =====
    if (cmd === "tdadmin") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      const target = mentionTarget(message);
      if (!target) return message.reply("Dùng: `.tdadmin @user`");
      if (target.user.bot) return message.reply("❌ Không thêm bot làm admin.");
      if (!db.admins.includes(target.id)) db.admins.push(target.id);
      ensureAdminWallet(target.id);
      saveDB();
      return message.reply(`✅ Đã thêm ${target} vào bot admin. Ví admin được đảm bảo **${money(ADMIN_START_TD)} TDĐ**.`);
    }

    if (cmd === "tdunadmin") {
      if (!isOwner(message)) return message.reply("⛔ Chỉ OWNER mới được xóa bot admin.");
      const target = mentionTarget(message);
      if (!target) return message.reply("Dùng: `.tdunadmin @user`");
      db.admins = db.admins.filter(id => id !== target.id);
      saveDB();
      return message.reply(`✅ Đã xóa ${target} khỏi bot admin.`);
    }

    if (cmd === "tdadmins") {
      if (!isAdmin(message)) return message.reply("⛔ Không có quyền.");
      const list = db.admins.length ? db.admins.map(id => `<@${id}>`).join("\n") : "Chưa có admin bổ sung.";
      return message.reply(`🛡️ **BOT ADMINS**\n👑 Owner: <@${OWNER_ID}> (${ADMIN_USERNAME})\n${list}`);
    }

    // ===== KÊNH GAME =====
    if (cmd === "tdchannel") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const targetChannel = message.mentions.channels.first();
      const mode = (args[0] || "").toLowerCase();
      if (mode === "off") {
        db.settings[message.guild.id] ||= {};
        delete db.settings[message.guild.id].gameChannelId;
        saveDB();
        return message.reply("✅ Đã bỏ giới hạn kênh game.");
      }
      if (!targetChannel) return message.reply(`🎮 Kênh game hiện tại: **${gameChannelLabel(message)}**\nDùng: ".tdchannel #ten-kenh"`);
      db.settings[message.guild.id] ||= {};
      db.settings[message.guild.id].gameChannelId = targetChannel.id;
      saveDB();
      return message.reply(`✅ Đã đặt kênh game thành ${targetChannel}.`);
    }

    // ===== TD ĐỒNG =====
    if (cmd === "tdcoin") {
      const u = ensureAdminWallet(message.author.id);
      saveDB();
      return message.reply(`💰 ${message.author} đang có **${money(tdValue(u))} TDĐ**.`);
    }

    if (cmd === "tdaddcoin" || cmd === "tdsubcoin") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      const target = mentionTarget(message);
      const amountRaw = args.find(x => /^\d+$/.test(x));
      if (!target || !amountRaw || BigInt(amountRaw) <= 0n) return message.reply(`Dùng: ".${cmd} @user <số TDĐ>"`);
      if (target.user.bot) return message.reply("❌ Không cộng/trừ TDĐ cho bot.");
      const amount = BigInt(amountRaw);
      const u = ensureAdminWallet(target.id);
      if (cmd === "tdaddcoin") addTD(u, amount);
      else setTD(u, tdValue(u) - amount);
      saveDB();
      return message.reply(`✅ ${cmd === "tdaddcoin" ? "Đã cộng" : "Đã trừ"} **${money(amount)} TDĐ** ${cmd === "tdaddcoin" ? "cho" : "của"} ${target}.\n💰 Số dư: **${money(tdValue(u))} TDĐ**`);
    }

    // ===== CODE THƯỞNG =====
    if (cmd === "tdcode" || cmd === "nhapcode") {
      const code = (args[0] || "").toUpperCase();
      const rewards = { TDFAMILY: 50000n, TD50K: 50000n };
      if (!rewards[code]) return message.reply("❌ Code không hợp lệ.");
      db.redeemedCodes[code] ||= [];
      if (db.redeemedCodes[code].includes(message.author.id)) return message.reply("❌ Mày đã nhập code này rồi.");
      const u = userData(message.author.id);
      addTD(u, rewards[code]);
      db.redeemedCodes[code].push(message.author.id);
      saveDB();
      return message.reply(`🎁 Nhập code **${code}** thành công!\n💰 +**${money(rewards[code])} TDĐ**\n💳 Số dư: **${money(tdValue(u))} TDĐ**`);
    }

    // ===== MODERATION =====
    if (cmd === "tdban") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const target = mentionTarget(message);
      if (!target) return message.reply("Dùng: `.tdban @user [lý do]`");
      if (!target.bannable) return message.reply("❌ Bot không thể ban người này. Kiểm tra quyền/hierarchy.");
      if (target.id === message.author.id) return message.reply("❌ Không thể tự ban.");
      const reason = cleanMentionText(message, args) || "Không có lý do";
      await target.ban({ reason: reason.slice(0, 500) });
      return message.reply(`🔨 Đã ban ${target.user.tag}.\nLý do: ${reason}`);
    }

    if (cmd === "tdmute") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const target = mentionTarget(message);
      if (!target) return message.reply("Dùng: `.tdmute @user 10m`");
      const durationArg = args.find(x => /^\d+(s|p|m|h|d)$/i.test(x));
      const ms = parseDuration(durationArg);
      if (!ms) return message.reply("❌ Thời gian sai. Ví dụ: `10s`, `5p`, `2h`, tối đa 28 ngày.");
      if (!target.moderatable) return message.reply("❌ Bot không thể mute người này. Kiểm tra quyền/hierarchy.");
      await target.timeout(ms, `TDMute bởi ${message.author.tag}`);
      return message.reply(`🔇 Đã mute ${target} trong **${durationArg}**.`);
    }

    // ===== TÀI XỈU ADMIN OVERRIDE =====
    if (cmd === "adtdtai" || cmd === "adtdxiu") {
      if (!isAdmin(message)) return message.reply("⛔ Chỉ bot admin mới dùng được.");
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      db.settings[message.guild.id] ||= {};
      db.settings[message.guild.id].txForcedType = cmd === "adtdtai" ? "tai" : "xiu";
      saveDB();
      return message.reply(`🛡️ Đã đặt kết quả ván Tài Xỉu kế tiếp về **${cmd === "adtdtai" ? "TÀI" : "XỈU"}**.\n⚠️ Kết quả sẽ được ghi rõ là Admin override.`);
    }

    // ===== SOI CẦU =====
    if (cmd === "cau") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      return message.reply(`📊 **CẦU TÀI XỈU — 20 VÁN GẦN NHẤT**\n${txHistoryText(message)}\n\n⚠️ Cầu chỉ là lịch sử kết quả, không đảm bảo dự đoán ván tiếp theo.`);
    }

    // ===== TÀI XỈU =====
    if (cmd === "tx") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const betRaw = args[0];
      const bet = /^\d+$/.test(betRaw || "") ? BigInt(betRaw) : 0n;
      const choiceRaw = (args[1] || "").toLowerCase();
      const choice = ["tai", "tài"].includes(choiceRaw) ? "tai" : ["xiu", "xỉu"].includes(choiceRaw) ? "xiu" : null;
      if (bet <= 0n || !choice) return message.reply("🎲 Dùng: `.tx <TDĐ> <tai|xiu>`\nVí dụ: `.tx 1000 tai`");
      return placeTxBet(message, bet, choice);
    }

    // ===== BẦU CUA =====
    if (cmd === "bc") {
      const bet = Number(args[0]);
      const face = (args[1] || "").toLowerCase();
      const faces = ["bau", "cua", "tom", "ca", "nai", "ga"];
      const aliases = { bầu: "bau", cua: "cua", tôm: "tom", cá: "ca", nai: "nai", gà: "ga" };
      const pick = aliases[face] || face;
      if (!Number.isInteger(bet) || bet <= 0 || !faces.includes(pick)) return message.reply("🦀 Dùng: `.bc <TDĐ> <bau|cua|tom|ca|nai|ga>`");
      const u = userData(message.author.id);
      if (!canAfford(u, bet)) return message.reply("❌ Không đủ TDĐ.");
      const roll = [0, 1, 2].map(() => faces[Math.floor(Math.random() * faces.length)]);
      const count = roll.filter(x => x === pick).length;
      if (count === 0) setTD(u, tdValue(u) - BigInt(bet));
      else addTD(u, BigInt(bet) * BigInt(count));
      saveDB();
      const icons = { bau: "🎃", cua: "🦀", tom: "🦐", ca: "🐟", nai: "🦌", ga: "🐓" };
      return message.reply(`🎰 **BẦU CUA**\n${roll.map(x => icons[x]).join(" ")}\nBạn chọn: **${pick.toUpperCase()}**\n${count ? `🟢 Có ${count} mặt → +${money(BigInt(bet) * BigInt(count))} TDĐ` : `🔴 Không có → -${money(bet)} TDĐ`}\n💰 Số dư: **${money(tdValue(u))} TDĐ**`);
    }

    // ===== NỐI TỪ =====
    if (cmd === "nttv" || cmd === "ntel") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const lang = cmd === "nttv" ? "vi" : "en";
      const phrase = startWordGame(message, lang);
      return message.reply(lang === "vi"
        ? `🇻🇳 **NỐI TỪ TIẾNG VIỆT** bắt đầu!\nTừ: **${phrase}**\n💰 Mỗi lượt đúng: **+1.000 TDĐ**\n🏁 Người nối cuối khi vào ngõ cụt: **+10.000 TDĐ**`
        : `🇬🇧 **ENGLISH WORD CHAIN** started!\nPhrase: **${phrase}**\n💰 Each correct turn: **+1,000 TDĐ**\n🏁 Last player at a dead end: **+10,000 TDĐ**`);
    }

    if (cmd === "ntstop") {
      const key = `${message.guildId}:${message.channelId}`;
      if (!wordGames.has(key)) return message.reply("❌ Không có game nối từ đang chạy.");
      wordGames.delete(key);
      return message.reply("🛑 Đã dừng game nối từ.");
    }

    // ===== TU TIÊN =====
    if (cmd === "tutien" || cmd === "tu") {
      const u = userData(message.author.id);
      const r = REALMS[u.realm];
      return message.reply(`🌌 **HỒ SƠ TU TIÊN**\n👤 Đạo hữu: **${message.author.displayName}**\n☯️ Cảnh giới: **${r.name}**\n✨ Tu vi: **${money(u.exp)} XP**\n⚔️ Công kích: **${u.attack}**\n🛡️ Phòng thủ: **${u.defense}**\n❤️ Sinh lực: **${u.hp}**\n💰 TD Đồng: **${money(tdValue(u))} TDĐ**`);
    }

    if (cmd === "tuluyen" || cmd === "tl") {
      const u = userData(message.author.id);
      const gain = Math.floor(Math.random() * 61) + 40;
      u.exp += gain;
      const oldRealm = u.realm;
      const leveled = promote(u);
      saveDB();
      return message.reply(`🧘 **Tu luyện thành công**\n✨ +${gain} tu vi\n${leveled ? `🔥 **Đột phá!** ${REALMS[oldRealm].name} → **${REALMS[u.realm].name}**` : `☯️ Cảnh giới: **${REALMS[u.realm].name}**`}\n📈 Tu vi hiện tại: **${money(u.exp)} XP**`);
    }

    if (cmd === "tudanh") {
      const target = mentionTarget(message);
      if (!target || target.id === message.author.id) return message.reply("Dùng: `.tudanh @user`");
      if (target.user.bot) return message.reply("❌ Không đấu với bot.");
      const a = userData(message.author.id);
      const b = userData(target.id);
      const powerA = a.attack + Math.floor(Math.random() * 31);
      const powerB = b.attack + Math.floor(Math.random() * 31);
      const win = powerA >= powerB;
      const reward = 100 + Math.floor(Math.random() * 201);
      if (win) { addTD(a, reward); a.exp += 50; }
      else { addTD(b, reward); b.exp += 50; }
      promote(a); promote(b);
      saveDB();
      return message.reply(`⚔️ **TU TIÊN ĐẤU PHÁP**\n${message.author} — **${REALMS[a.realm].name}**: ${powerA} lực\n${target} — **${REALMS[b.realm].name}**: ${powerB} lực\n\n🏆 Kẻ thắng: **${win ? message.author.displayName : target.displayName}**\n💰 Phần thưởng: **+${reward} TDĐ**\n✨ +50 tu vi cho người thắng`);
    }

    // ===== DAILY =====
    if (cmd === "tddaily") {
      const u = userData(message.author.id);
      const now = Date.now();
      if (now - u.lastDaily < 24 * 60 * 60 * 1000) {
        const remain = 24 * 60 * 60 * 1000 - (now - u.lastDaily);
        const h = Math.floor(remain / 3600000);
        const m = Math.floor((remain % 3600000) / 60000);
        return message.reply(`⏳ Còn **${h}h ${m}p** nữa mới nhận daily.`);
      }
      addTD(u, 500n);
      u.lastDaily = now;
      saveDB();
      return message.reply(`🎁 Nhận daily thành công: **+500 TDĐ**. Tổng: **${money(tdValue(u))} TDĐ**`);
    }

    if (cmd === "help") return message.reply("Dùng `.game` để xem toàn bộ lệnh.");
  } catch (err) {
    console.error(err);
    if (message.channel?.isTextBased()) await message.reply("❌ Bot gặp lỗi khi xử lý lệnh. Kiểm tra console.");
  }
});

client.login(TOKEN);const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});