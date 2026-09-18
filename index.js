const http = require("http");
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("TriDung Dev Bot is running!");
}).listen(PORT, "0.0.0.0", () => console.log(`Web server running on port ${PORT}`));

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
if (!TOKEN || !OWNER_ID) {
  console.error("Thiếu DISCORD_TOKEN hoặc OWNER_ID trong .env");
  process.exit(1);
}

const PREFIX = ".";
const DB_FILE = path.join(__dirname, "data", "db.json");
const ADMIN_START_TD = 1000000000000000000n; // 1.000.000.000 tỷ TDĐ = 10^18
const TX_WINDOW_MS = 35_000;
const TX_HISTORY_LIMIT = 30;
const OPENING_VIDEO = path.join(__dirname, "assets", "mo-bat.mp4");
const LOOP_MAX_MESSAGES = 100;
const LOOP_MIN_MS = 1_000; // Discord-safe minimum: 1s
const LOOP_MAX_MS = 1_000_000; // 1000s
const treoLoops = new Map();
const nhayTagLoops = new Map();
const stockRounds = new Map();
const STOCK_WINDOW_MS = 15_000;
const STOCK_IMAGE_BUY = path.join(__dirname, "assets", "stock-buy.jpg");
const STOCK_IMAGE_SELL = path.join(__dirname, "assets", "stock-sell.jpg");
const DICE_GIF = path.join(__dirname, "assets", "dice-roll.gif");
const DMENU_BANNER = path.join(__dirname, "assets", "dmenu-banner.jpg");

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
      // td = TD Đồng. coins được giữ lại để migrate DB cũ.
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
  if (u.coins == null) u.coins = u.td; // migrate DB cũ
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
  u.coins = u.td; // giữ tương thích DB cũ
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
  return message.author.id === OWNER_ID || db.admins.includes(message.author.id);
}

function isOwner(message) {
  return message.author.id === OWNER_ID;
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
// Mỗi guild/channel có một phiên cược. Phiên tự mở bát sau 35 giây.
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
  // Tạo một bộ 3 xúc sắc hợp lệ cho Tài/Xỉu.
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
  // Override chỉ áp dụng cho đúng một ván rồi tự xoá.
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
      // Cược được tính theo kiểu hoàn vốn + lợi nhuận bằng đúng tiền cược.
      addTD(u, BigInt(bet.amount) * 2n);
      lines.push(`🟢 <@${bet.userId}> thắng +${money(bet.amount)} TDĐ`);
    } else {
      lines.push(`🔴 <@${bet.userId}> thua -${money(bet.amount)} TDĐ`);
    }
  }

  saveDB();
  txRounds.delete(key);

  const forcedText = forced ? `\n🛡️ Admin override: **${forced === "tai" ? "TÀI" : "XỈU"}**` : "";

  // Mở bát: dùng GIF xúc sắc quay, rồi mới công bố kết quả.
  if (fs.existsSync(DICE_GIF)) {
    await message.channel.send({
      content: "🎲 **XÚC SẮC ĐANG QUAY...**",
      files: [DICE_GIF]
    });
    await new Promise(resolve => setTimeout(resolve, 2_200));
  } else if (fs.existsSync(OPENING_VIDEO)) {
    await message.channel.send({
      content: "🎲 **MỞ BÁT...**",
      files: [OPENING_VIDEO]
    });
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }

  await message.channel.send(
`🎲 **KẾT QUẢ TÀI XỈU**
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

  // Trừ tiền ngay khi đặt cược để không thể spam vượt số dư.
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

// Từ điển đủ lớn để xác định một nhánh đã đi vào ngõ cụt.
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

  // Mỗi lượt đúng +1.000 TDĐ.
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

// ===================== TREO / NHÂY TAG =====================
function stopTreo(channelId) {
  const loop = treoLoops.get(channelId);
  if (!loop) return false;
  clearInterval(loop.timer);
  treoLoops.delete(channelId);
  return true;
}

function stopNhayTag(channelId) {
  const loop = nhayTagLoops.get(channelId);
  if (!loop) return false;
  clearInterval(loop.timer);
  nhayTagLoops.delete(channelId);
  return true;
}

function loadNhayTagLines() {
  const file = path.join(__dirname, "data", "nhay.txt");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function startTreo(message, text, intervalMs) {
  stopTreo(message.channelId);
  let sent = 0;
  const sendOne = async () => {
    if (!treoLoops.has(message.channelId) || sent >= LOOP_MAX_MESSAGES) {
      stopTreo(message.channelId);
      return;
    }
    sent++;
    await message.channel.send(text);
  };
  const timer = setInterval(sendOne, intervalMs);
  treoLoops.set(message.channelId, { timer, ownerId: message.author.id });
  sendOne();
}

function loadNhayCuoiLagLines() {
  const file = path.join(__dirname, "data", "nhaycuoilag.txt");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map(x => x.replace(/\r?\n/g, " ").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeOneLine(text, maxLen = 1500) {
  // Discord giới hạn message 2000 ký tự; giữ 1500 ký tự để còn chỗ cho mention + nhaytag.
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function startNhayTag(message, targetId, intervalMs) {
  const lines = loadNhayTagLines();
  const lagLines = loadNhayCuoiLagLines();
  if (!lines.length) return false;
  stopNhayTag(message.channelId);
  let index = 0;
  let sent = 0;
  const sendOne = async () => {
    if (!nhayTagLoops.has(message.channelId) || sent >= LOOP_MAX_MESSAGES) {
      stopNhayTag(message.channelId);
      return;
    }

    const tagText = safeOneLine(lines[index % lines.length], 600);
    const lagText = lagLines.length
      ? safeOneLine(lagLines[index % lagLines.length], 1200)
      : "";

    // Một lần gửi = đúng một Discord message, không dùng \n.
    const text = safeOneLine(`<@${targetId}> ${tagText} ${lagText}`, 1950);
    index++;
    sent++;
    await message.channel.send(text);
  };
  const timer = setInterval(sendOne, intervalMs);
  nhayTagLoops.set(message.channelId, { timer, ownerId: message.author.id });
  sendOne();
  return true;
}

// ===================== NÚT BẤM / UI =====================
function treoButtons(active = true) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("treo_start").setLabel("Treo").setStyle(ButtonStyle.Success).setDisabled(active),
    new ButtonBuilder().setCustomId("treo_stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(!active)
  )];
}

function txButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tx_xiu").setLabel("3-10 Xỉu").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("tx_tai").setLabel("11-18 Tài").setStyle(ButtonStyle.Primary)
  )];
}

function stockButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("stock_buy").setLabel("MUA").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("stock_sell").setLabel("BÁN").setStyle(ButtonStyle.Danger)
  )];
}

function dmenuButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_tx").setLabel("🎲 Tài Xỉu").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu_stock").setLabel("📈 Chứng khoán").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu_treo").setLabel("🔁 Treo").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu_tutien").setLabel("🌌 Tu Tiên").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu_admin").setLabel("🛡️ Admin").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_nhaytag").setLabel("🏷️ Nhây Tag").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("menu_games").setLabel("🎮 Game").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("menu_coin").setLabel("💰 TD Đồng").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("menu_stop").setLabel("🛑 Stop").setStyle(ButtonStyle.Danger)
    )
  ];
}

function tutienButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tutien_luyen").setLabel("⚔️ Tu Luyện").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("tutien_profile").setLabel("📜 Hồ Sơ").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("back_dmenu").setLabel("↩️ Quay lại").setStyle(ButtonStyle.Secondary)
  )];
}

function adminMenuButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_commands").setLabel("🛡️ Lệnh Admin").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("back_dmenu").setLabel("↩️ Quay lại").setStyle(ButtonStyle.Secondary)
  )];
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function cpuLoadText() {
  const loads = os.loadavg();
  // Trên Linux/Render dùng load average 1 phút; không phải % CPU chính xác.
  return `${loads[0].toFixed(2)} load`;
}

function dmenuEmbed(client) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("✦ TÂM ĐIỂM ĐIỀU KHIỂN ✦")
    .setDescription(
      `Xin chào **${client.user.username}** 👋\n` +
      `Hãy chạm vào các nút bên dưới để truy cập tính năng.\n\n` +
      `👑 **Developer**\n**Trí Dũng <The Alex>**\n\n` +
      `📡 **Ping**\n**${client.ws.ping}ms**\n\n` +
      `💻 **CPU Load**\n**${cpuLoadText()}**\n\n` +
      `⏱️ **Uptime**\n**${formatUptime(client.uptime || 0)}**\n\n` +
      `🌐 **Máy chủ**\n**${client.guilds.cache.size}**`
    )
    .setFooter({ text: "TRIDUNG DEV • !dmenu" })
    .setTimestamp();
}

function txMenuText() {
  return `🎲 **TÀI XỈU — MỞ BÁT 35 GIÂY**\n\n🔴 **3-10 XỈU**\n🟧 **11-18 TÀI**\n\nBấm nút để chọn cửa, sau đó nhập số TDĐ trong cửa sổ hiện ra.`;
}

function adminMenuText() {
  return `🛡️ **MENU ADMIN**\n\n` +
    `• \.tdadmins — Xem danh sách admin\n` +
    `• \.tdadmin @user — Thêm admin\n` +
    `• \.tdunadmin @user — Xóa admin\n` +
    `• \.tdaddcoin @user <TDĐ> — Cộng TDĐ\n` +
    `• \.tdsubcoin @user <TDĐ> — Trừ TDĐ\n` +
    `• \.tdmute @user <thời gian> — Mute\n` +
    `• \.tdban @user — Ban\n` +
    `• \.tdchannel #kênh — Đặt kênh game\n` +
    `• \.adtdtai / \.adtdxiu — Override ván TX tiếp theo\n\n` +
    `⚠️ Chỉ OWNER/ADMIN mới thực thi được các lệnh trên.`;
}

function nhayTagModal() {
  return new ModalBuilder().setCustomId("nhaytag_id_modal").setTitle("Nhây Tag").addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("target_id").setLabel("ID người dùng").setStyle(TextInputStyle.Short).setPlaceholder("123456789012345678").setRequired(true).setMinLength(17).setMaxLength(20)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("interval").setLabel("Khoảng cách (1-1000s)").setStyle(TextInputStyle.Short).setPlaceholder("1s").setRequired(true)
    )
  );
}

function stockMenuText() {
  return `📈 **TD STOCK — VÁN 15 GIÂY**\n\n🟢 **MUA** = dự đoán giá tăng\n🔴 **BÁN** = dự đoán giá giảm\n\nMỗi ván kéo dài **15 giây**. Hết giờ bot công bố biến động giá, kết quả và ảnh biểu đồ.\n\n⚠️ Đây là **game mô phỏng bằng TDĐ**, tỷ lệ biến động được tạo ngẫu nhiên theo khoảng giống thị trường; không phải dữ liệu/chứng khoán thật.`;
}

function createAmountModal(customId, title, actionLabel) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("amount").setLabel("Số TDĐ").setStyle(TextInputStyle.Short).setPlaceholder("Ví dụ: 1000").setRequired(true).setMinLength(1).setMaxLength(18)
    )
  );
}

function parseAmount(value) {
  if (!/^\d+$/.test(String(value || ""))) return null;
  try { const n = BigInt(value); return n > 0n ? n : null; } catch { return null; }
}

function stockKey(message) { return `${message.guildId}:${message.channelId}`; }

async function finishStockRound(message, key) {
  const round = stockRounds.get(key);
  if (!round || round.finished) return;
  round.finished = true;
  const movement = (Math.random() * 16 - 8); // mô phỏng -8% .. +8%
  const up = movement >= 0;
  const priceBefore = 100 + Math.random() * 30;
  const priceAfter = priceBefore * (1 + movement / 100);
  const resultLines = [];
  for (const bet of round.bets.values()) {
    const u = userData(bet.userId);
    const win = (bet.choice === "buy" && up) || (bet.choice === "sell" && !up);
    if (win) {
      addTD(u, BigInt(bet.amount) * 2n);
      resultLines.push(`🟢 <@${bet.userId}> **${bet.choice === "buy" ? "MUA" : "BÁN"}** thắng +${money(bet.amount)} TDĐ`);
    } else {
      resultLines.push(`🔴 <@${bet.userId}> **${bet.choice === "buy" ? "MUA" : "BÁN"}** thua -${money(bet.amount)} TDĐ`);
    }
  }
  saveDB();
  stockRounds.delete(key);
  const imgPath = up ? STOCK_IMAGE_BUY : STOCK_IMAGE_SELL;
  const file = fs.existsSync(imgPath) ? new AttachmentBuilder(imgPath) : null;
  const direction = up ? "TĂNG" : "GIẢM";
  const sign = movement >= 0 ? "+" : "";
  const embed = new EmbedBuilder()
    .setTitle(`📈 KẾT QUẢ TD STOCK — ${direction}`)
    .setDescription(`💹 Giá mở: **${priceBefore.toFixed(2)}**\n📊 Biến động: **${sign}${movement.toFixed(2)}%**\n🏁 Giá đóng: **${priceAfter.toFixed(2)}**\n\n${resultLines.length ? resultLines.join("\n") : "Không có lệnh."}`)
    .setTimestamp();
  if (file) embed.setImage(`attachment://${path.basename(imgPath)}`);
  await message.channel.send({ embeds: [embed], ...(file ? { files: [file] } : {}) });
}

function startStockRound(message) {
  const key = stockKey(message);
  let round = stockRounds.get(key);
  if (round && !round.finished) return false;
  round = { createdAt: Date.now(), bets: new Map(), finished: false };
  stockRounds.set(key, round);
  setTimeout(() => finishStockRound(message, key), STOCK_WINDOW_MS);
  return true;
}

async function placeStockBet(interaction, choice, amount) {
  const message = interaction.message;
  const key = stockKey(message);
  let round = stockRounds.get(key);
  if (!round) {
    startStockRound(message);
    round = stockRounds.get(key);
  }
  if (!round || round.finished) return interaction.reply({ content: "⛔ Ván đã kết thúc.", ephemeral: true });
  const u = userData(interaction.user.id);
  const old = round.bets.get(interaction.user.id);
  if (!canAfford(u, amount)) return interaction.reply({ content: "❌ Không đủ TDĐ.", ephemeral: true });
  if (old) {
    setTD(u, tdValue(u) - amount);
    old.amount = (BigInt(old.amount) + amount).toString();
    old.choice = choice;
  } else {
    setTD(u, tdValue(u) - amount);
    round.bets.set(interaction.user.id, { userId: interaction.user.id, amount: amount.toString(), choice });
  }
  saveDB();
  const left = Math.max(0, STOCK_WINDOW_MS - (Date.now() - round.createdAt));
  return interaction.reply({ content: `📈 Đã đặt **${money(amount)} TDĐ** vào **${choice === "buy" ? "MUA" : "BÁN"}**. Còn ~**${Math.ceil(left / 1000)}s**.`, ephemeral: true });
}

// ===================== DISCORD =====================
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === "back_dmenu") {
        const payload = { embeds: [dmenuEmbed(client)], components: dmenuButtons(), files: [] };
        return interaction.update(payload);
      }
      if (id === "menu_tutien") {
        return interaction.reply({ content: `🌌 **TU TIÊN**\n\nChọn một chức năng:`, components: tutienButtons(), ephemeral: true });
      }
      if (id === "tutien_luyen") {
        return interaction.reply({ content: `⚔️ **TU LUYỆN**\n\nDùng \.tuluyen để tu luyện và nhận EXP.`, ephemeral: true });
      }
      if (id === "tutien_profile") {
        const u = userData(interaction.user.id);
        const realm = REALMS[u.realm] || REALMS[0];
        return interaction.reply({ content: `📜 **HỒ SƠ TU TIÊN**\n👤 ${interaction.user}\n🌌 Cảnh giới: **${realm.name}**\n✨ EXP: **${u.exp}**\n⚔️ ATK: **${u.attack}**\n🛡️ DEF: **${u.defense}**\n❤️ HP: **${u.hp}**\n💰 TDĐ: **${money(tdValue(u))}**`, ephemeral: true });
      }
      if (id === "menu_admin") {
        return interaction.reply({ content: adminMenuText(), components: adminMenuButtons(), ephemeral: true });
      }
      if (id === "admin_commands") {
        if (!isAdmin({ author: { id: interaction.user.id } })) return interaction.reply({ content: "⛔ Mày không có quyền admin.", ephemeral: true });
        return interaction.reply({ content: adminMenuText(), ephemeral: true });
      }
      if (id === "menu_nhaytag") {
        return interaction.showModal(nhayTagModal());
      }
      if (id === "menu_tx") return interaction.reply({ content: txMenuText(), components: txButtons(), ephemeral: true });
      if (id === "menu_stock") return interaction.reply({ content: stockMenuText(), components: stockButtons(), ephemeral: true });
      if (id === "menu_treo") {
        const modal = new ModalBuilder().setCustomId("treo_modal").setTitle("Treo tin nhắn");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("text").setLabel("Nội dung").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("interval").setLabel("Khoảng cách (1-1000s)").setStyle(TextInputStyle.Short).setPlaceholder("5s").setRequired(true))
        );
        return interaction.showModal(modal);
      }
      if (id === "menu_games") return interaction.reply({ content: `🎮 **GAME**\n\`.tx\` — Tài Xỉu\n\`.bc\` — Bầu Cua\n\`.nttv\` — Nối từ Việt\n\`.ntel\` — Nối từ Anh\n\`.tutien\` — Tu Tiên`, ephemeral: true });
      if (id === "menu_coin") return interaction.reply({ content: `💰 Dùng \`.tdcoin\` để xem số dư TDĐ.`, ephemeral: true });
      if (id === "nhay_stop_button") {
        return interaction.reply({ content: stopNhayTag(interaction.channelId) ? "🛑 Đã dừng nhây tag." : "❌ Không có nhây tag đang chạy.", ephemeral: true });
      }
      if (id === "menu_stop") {
        const a = stopTreo(interaction.channelId);
        const b = stopNhayTag(interaction.channelId);
        return interaction.reply({ content: (a || b) ? "🛑 Đã dừng vòng lặp đang chạy." : "❌ Không có vòng lặp để dừng.", ephemeral: true });
      }
      if (id === "treo_stop") {
        return interaction.reply({ content: stopTreo(interaction.channelId) ? "🛑 Đã dừng treo." : "❌ Không có treo đang chạy.", ephemeral: true });
      }
      if (id === "treo_start") {
        const modal = new ModalBuilder().setCustomId("treo_modal").setTitle("Treo tin nhắn");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("text").setLabel("Nội dung").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("interval").setLabel("Khoảng cách (1-1000s)").setStyle(TextInputStyle.Short).setPlaceholder("5s").setRequired(true))
        );
        return interaction.showModal(modal);
      }
      if (id === "tx_xiu" || id === "tx_tai") return interaction.showModal(createAmountModal(id === "tx_xiu" ? "tx_modal_xiu" : "tx_modal_tai", id === "tx_xiu" ? "Cược 3-10 Xỉu" : "Cược 11-18 Tài"));
      if (id === "stock_buy" || id === "stock_sell") return interaction.showModal(createAmountModal(id === "stock_buy" ? "stock_modal_buy" : "stock_modal_sell", id === "stock_buy" ? "MUA TD STOCK" : "BÁN TD STOCK"));
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "nhaytag_id_modal") {
        if (!interaction.guild) return interaction.reply({ content: "❌ Chỉ dùng trong server.", ephemeral: true });
        const targetId = interaction.fields.getTextInputValue("target_id").trim();
        if (!/^\d{17,20}$/.test(targetId)) return interaction.reply({ content: "❌ ID Discord không hợp lệ.", ephemeral: true });
        if (targetId === interaction.user.id) return interaction.reply({ content: "❌ Không thể nhây tag chính mình.", ephemeral: true });
        const member = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (!member) return interaction.reply({ content: "❌ Không tìm thấy người dùng này trong server.", ephemeral: true });
        if (member.user.bot) return interaction.reply({ content: "❌ Không nhây tag bot.", ephemeral: true });
        const intervalArg = interaction.fields.getTextInputValue("interval").trim();
        const intervalMs = parseDuration(intervalArg);
        if (!intervalMs || intervalMs < LOOP_MIN_MS || intervalMs > LOOP_MAX_MS) {
          return interaction.reply({ content: "❌ Thời gian phải từ **1s đến 1000s**. Ví dụ: `1s`, `10s`, `1000s`.", ephemeral: true });
        }
        const fake = { guild: interaction.guild, guildId: interaction.guildId, channelId: interaction.channelId, author: interaction.user, channel: interaction.channel };
        const started = startNhayTag(fake, targetId, intervalMs);
        if (!started) return interaction.reply({ content: "❌ Không đọc được data/nhay.txt.", ephemeral: true });
        return interaction.reply({ content: `🏷️ Đã bắt đầu nhây tag <@${targetId}> mỗi **${intervalArg}**. Tối đa **${LOOP_MAX_MESSAGES} tin**; dùng nút Stop hoặc \.nhaystop để dừng.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("nhay_stop_button").setLabel("Stop").setStyle(ButtonStyle.Danger))] });
      }
      if (interaction.customId === "treo_modal") {
        const text = interaction.fields.getTextInputValue("text").trim();
        const intervalArg = interaction.fields.getTextInputValue("interval").trim();
        const ms = parseDuration(intervalArg);
        if (!text || text.length > 500 || !ms || ms < LOOP_MIN_MS || ms > LOOP_MAX_MS) return interaction.reply({ content: "❌ Nội dung tối đa 500 ký tự, thời gian 1-1000s.", ephemeral: true });
        const fake = { channelId: interaction.channelId, author: interaction.user, channel: interaction.channel };
        startTreo(fake, text, ms);
        return interaction.reply({ content: `🟢 Đã **Treo** mỗi ${intervalArg}. Dùng nút **Stop** hoặc \`.sttreo\` để dừng.`, components: treoButtons(true) });
      }

      // Chỉ các modal cược mới đọc field "amount". Modal Treo không có field này.
      const amount = parseAmount(interaction.fields.getTextInputValue("amount"));
      if (interaction.customId === "tx_modal_xiu" || interaction.customId === "tx_modal_tai") {
        if (!amount) return interaction.reply({ content: "❌ Số TDĐ không hợp lệ.", ephemeral: true });
        const choice = interaction.customId.endsWith("xiu") ? "xiu" : "tai";
        const fake = interaction.message;
        const msg = { guildId: interaction.guildId, channelId: interaction.channelId, author: interaction.user, guild: interaction.guild, channel: interaction.channel, reply: (x) => interaction.reply(x) };
        return placeTxBet(msg, amount, choice);
      }
      if (interaction.customId === "stock_modal_buy" || interaction.customId === "stock_modal_sell") {
        if (!amount) return interaction.reply({ content: "❌ Số TDĐ không hợp lệ.", ephemeral: true });
        return placeStockBet(interaction, interaction.customId.endsWith("buy") ? "buy" : "sell", amount);
      }
    }
  } catch (err) {
    console.error("Interaction error:", err?.stack || err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Lỗi xử lý nút: ${String(err?.message || err).slice(0, 180)}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    if (message.author.id === OWNER_ID || db.admins.includes(message.author.id)) {
      ensureAdminWallet(message.author.id);
    }

    if (message.guild && await checkWordGame(message)) return;
    if (message.content.trim().toLowerCase() === "!dmenu") {
      const payload = { embeds: [dmenuEmbed(client)], components: dmenuButtons() };
      if (fs.existsSync(DMENU_BANNER)) {
        const file = new AttachmentBuilder(DMENU_BANNER);
        payload.files = [file];
        payload.embeds[0].setImage(`attachment://${path.basename(DMENU_BANNER)}`);
      }
      return message.reply(payload);
    }

    if (!message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    const gameCommands = new Set([
      "game",
      "stock", "tx", "cau", "bc", "nttv", "ntel", "ntstop",
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

🔁 **TREO / NHÂY TAG**
\`.treo <nội dung>\` — Lặp nội dung (tối đa 100 tin/lần)
\`.sttreo\` — Dừng treo
\`.nhaytag @user\` — Nhây tag theo file nhay.txt (tối đa 100 tin/lần)
\`.nhaystop\` — Dừng nhây tag

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
      const list = db.admins.length ? db.admins.map(id => `<@${id}>`).join("\n") : "Chưa có admin.";
      return message.reply(`🛡️ **BOT ADMINS**\n👑 Owner: <@${OWNER_ID}>\n${list}`);
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

    // ===== TREO / NHÂY TAG =====
    if (cmd === "treo") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const durationArg = args.find(x => /^\d+s$/i.test(x));
      const intervalMs = durationArg ? parseDuration(durationArg) : null;
      const text = args.filter(x => x !== durationArg).join(" ").trim();
      if (!text || !durationArg) return message.reply("Dùng: `.treo <nội dung> <1-1000s>`\nVí dụ: `.treo hello 5s`");
      if (!intervalMs || intervalMs < LOOP_MIN_MS || intervalMs > LOOP_MAX_MS) return message.reply("❌ Thời gian phải từ **1s đến 1000s**.");
      if (text.length > 500) return message.reply("❌ Nội dung tối đa 500 ký tự.");
      startTreo(message, text, intervalMs);
      return message.reply({ content: `🟢 Đã **Treo** mỗi **${durationArg}** (tối đa ${LOOP_MAX_MESSAGES} tin).`, components: treoButtons(true) });
    }

    if (cmd === "sttreo") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      return message.reply(stopTreo(message.channelId) ? "🛑 Đã dừng treo." : "❌ Kênh này không có treo đang chạy.");
    }

    if (cmd === "nhaytag") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      const target = mentionTarget(message);
      const durationArg = args.find(x => /^\d+s$/i.test(x));
      const intervalMs = durationArg ? parseDuration(durationArg) : null;
      if (!target || !durationArg) return message.reply("Dùng: `.nhaytag @user <1-1000s>`\nVí dụ: `.nhaytag @user 5s`");
      if (!intervalMs || intervalMs < LOOP_MIN_MS || intervalMs > LOOP_MAX_MS) return message.reply("❌ Thời gian phải từ **1s đến 1000s**.");
      if (target.user.bot) return message.reply("❌ Không nhây tag bot.");
      const started = startNhayTag(message, target.id, intervalMs);
      if (!started) return message.reply("❌ Không đọc được data/nhay.txt.");
      return message.reply(`🏷️ Đã bắt đầu nhay tag mỗi **${durationArg}** (tối đa ${LOOP_MAX_MESSAGES} tin).`);
    }

    if (cmd === "nhaystop") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      return message.reply(stopNhayTag(message.channelId) ? "🛑 Đã dừng nhây tag." : "❌ Kênh này không có nhây tag đang chạy.");
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
    // Lệnh này không ẩn với người dùng trong log bot: khi có override, bot ghi rõ "Admin override" ở kết quả.
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
      if (bet <= 0n || !choice) return message.reply({ content: txMenuText(), components: txButtons() });
      return placeTxBet(message, bet, choice);
    }

    // ===== CHỨNG KHOÁN =====
    if (cmd === "stock" || cmd === "chungkhoan" || cmd === "ck") {
      if (!message.guild) return message.reply("❌ Chỉ dùng trong server.");
      if (!startStockRound(message)) return message.reply("⏳ Ván chứng khoán hiện tại vẫn đang chạy.");
      return message.reply({ content: `${stockMenuText()}\n\n⏱️ **15s bắt đầu từ bây giờ.**`, components: stockButtons() });
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

client.login(TOKEN);
