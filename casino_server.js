// SAIMON CASINO — отдельный сервер, общая база пользователей с SAIMONGRAM
// Использует тот же DATABASE_URL и те же таблицы users/gifts
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.CASINO_PORT || process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Shared DB (та же что у мессенджера) ───────────────────────────────────
let pool = null;
if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const cs = new URL(process.env.DATABASE_URL);
    pool = new Pool({
        host: cs.hostname, port: Number(cs.port) || 5432,
        database: cs.pathname.slice(1),
        user: cs.username, password: cs.password,
        ssl: { rejectUnauthorized: false }, max: 5
    });
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
    users:  path.join(DATA_DIR, 'users.json'),
    gifts:  path.join(DATA_DIR, 'gifts.json'),
    casino: path.join(DATA_DIR, 'casino.json'),   // история ставок казино
};
const cache = {}, dirty = new Set();
function read(f) {
    if (cache[f]) return cache[f];
    if (pool) return cache[f] || [];
    try { cache[f] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { cache[f] = []; }
    return cache[f];
}
function write(f, d) { cache[f] = d; dirty.add(f); }

async function dbGet(key) {
    if (!pool) return null;
    try { const r = await pool.query('SELECT value FROM kv WHERE key=$1', [key]); return r.rows[0] ? JSON.parse(r.rows[0].value) : null; } catch { return null; }
}
async function dbSet(key, val) {
    if (!pool) return;
    const s = JSON.stringify(val);
    await pool.query('INSERT INTO kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [key, s]);
}

async function loadFromDB() {
    if (!pool) return;
    cache[FILES.users]  = (await dbGet('users'))  || [];
    cache[FILES.gifts]  = (await dbGet('gifts'))  || [];
    cache[FILES.casino] = (await dbGet('casino')) || [];
}
async function persist() {
    if (!pool) { for (const f of dirty) { fs.writeFileSync(f, JSON.stringify(cache[f])); } dirty.clear(); return; }
    const tasks = [];
    if (dirty.has(FILES.users))  tasks.push(dbSet('users',  cache[FILES.users]));
    if (dirty.has(FILES.gifts))  tasks.push(dbSet('gifts',  cache[FILES.gifts]));
    if (dirty.has(FILES.casino)) tasks.push(dbSet('casino', cache[FILES.casino]));
    await Promise.all(tasks); dirty.clear();
}
setInterval(() => { if (dirty.size) persist().catch(console.error); }, 15000).unref();

// ─── Auth (те же пароли, те же токены что у мессенджера) ───────────────────
const sessions = {};
const isHash = s => typeof s === 'string' && s.includes(':') && s.length > 40;
const hashPass = (p, salt = crypto.randomBytes(8).toString('hex')) =>
    salt + ':' + crypto.createHmac('sha256', salt).update(p).digest('hex');
const checkPass = (p, stored) => isHash(stored) ? hashPass(p, stored.split(':')[0]) === stored : p === stored;

function authMW(req, res, next) {
    const tok = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const s = sessions[tok];
    if (!s) return res.status(401).json({ error: 'Не авторизован' });
    req.uid = s.uid; next();
}

app.post('/api/casino/login', (req, res) => {
    const users = read(FILES.users);
    const login = String(req.body.login || '').trim().toLowerCase().replace(/^@/, '');
    const pass  = String(req.body.password || '');
    const user  = users.find(u => (u.email && u.email.toLowerCase() === login) || (u.handle && u.handle === login));
    if (!user || !checkPass(pass, user.password)) return res.status(400).json({ error: 'Неверный логин или пароль' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { uid: user.id };
    res.json({ token, user: { id: user.id, username: user.username, handle: user.handle, avatar: user.avatar || '', mars: user.mars || 0, gifts: read(FILES.gifts).filter(g => g.ownerId === user.id && !g.listing) } });
});

app.get('/api/casino/me', authMW, (req, res) => {
    const u = read(FILES.users).find(x => x.id === req.uid);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    res.json({ id: u.id, username: u.username, handle: u.handle, avatar: u.avatar || '', mars: u.mars || 0,
        gifts: read(FILES.gifts).filter(g => g.ownerId === u.id && !g.listing) });
});

// ─── Каталог NFT ───────────────────────────────────────────────────────────
const CATALOG = [
    { kind: 'heart',    rarity: 'common',    emoji: '💝', name: 'Сердечко',      price: 15,    supply: 10000, bg: ['#ff9aa2','#ff5e7e'] },
    { kind: 'star',     rarity: 'common',    emoji: '⭐', name: 'Звезда',        price: 20,    supply: 5000,  bg: ['#ffe29a','#ffa751'] },
    { kind: 'flower',   rarity: 'common',    emoji: '🌸', name: 'Сакура',        price: 25,    supply: 4000,  bg: ['#ffd1dc','#f78fb3'] },
    { kind: 'coffee',   rarity: 'common',    emoji: '☕', name: 'Кофе',          price: 30,    supply: 4000,  bg: ['#d7b899','#8b5e3c'] },
    { kind: 'bear',     rarity: 'common',    emoji: '🧸', name: 'Мишка',         price: 50,    supply: 2000,  bg: ['#ffd89b','#f2a65a'] },
    { kind: 'cat',      rarity: 'common',    emoji: '🐱', name: 'Котик',         price: 60,    supply: 2500,  bg: ['#cfd9ff','#8e9eea'] },
    { kind: 'balloon',  rarity: 'rare',      emoji: '🎈', name: 'Шарик',         price: 80,    supply: 1500,  bg: ['#ff9a9e','#e8505b'] },
    { kind: 'rocket',   rarity: 'rare',      emoji: '🚀', name: 'Ракета',        price: 120,   supply: 1000,  bg: ['#a1c4fd','#5b7cfa'] },
    { kind: 'gamepad',  rarity: 'rare',      emoji: '🎮', name: 'Геймпад',       price: 150,   supply: 800,   bg: ['#a18cd1','#5f4bb6'] },
    { kind: 'rose',     rarity: 'rare',      emoji: '🌹', name: 'Роза',          price: 180,   supply: 700,   bg: ['#ff7e8b','#b3123b'] },
    { kind: 'ghost',    rarity: 'rare',      emoji: '👻', name: 'Призрак',       price: 250,   supply: 600,   bg: ['#c9d3ff','#7d8bd1'] },
    { kind: 'diamond',  rarity: 'epic',      emoji: '💎', name: 'Бриллиант',     price: 500,   supply: 300,   bg: ['#84fab0','#2bb3c0'] },
    { kind: 'unicorn',  rarity: 'epic',      emoji: '🦄', name: 'Единорог',      price: 700,   supply: 200,   bg: ['#f5a8ff','#6fa8ff'] },
    { kind: 'crown',    rarity: 'epic',      emoji: '👑', name: 'Корона',        price: 1000,  supply: 100,   bg: ['#f6d365','#e8a020'] },
    { kind: 'alien',    rarity: 'legendary', emoji: '👽', name: 'Марсианин',     price: 2000,  supply: 50,    bg: ['#b0f3a3','#2f9e44'] },
    { kind: 'dragon',   rarity: 'legendary', emoji: '🐉', name: 'Дракон',        price: 5000,  supply: 10,    bg: ['#ff9966','#c0392b'] },
    { kind: 'phoenix',  rarity: 'legendary', emoji: '🦅', name: 'Феникс',        price: 15000, supply: 3,     bg: ['#ffd200','#f12711'] },
];

const BACKDROPS = [
    { id: 'fog',     name: 'Серый туман',   pct: 18,  c: ['#d7dde5','#98a4b3'] },
    { id: 'sky',     name: 'Небесный',      pct: 16,  c: ['#a8d8ff','#4a93e0'] },
    { id: 'mint',    name: 'Мятный',        pct: 14,  c: ['#b8f0d4','#3fb98a'] },
    { id: 'peach',   name: 'Персик',        pct: 12,  c: ['#ffd3b6','#f08a5d'] },
    { id: 'lilac',   name: 'Сирень',        pct: 10,  c: ['#e3c9ff','#9a6fd8'] },
    { id: 'lime',    name: 'Лаймовый',      pct: 8,   c: ['#e4f99a','#8fc31f'] },
    { id: 'berry',   name: 'Малиновый',     pct: 7,   c: ['#ffa6c9','#d6336c'] },
    { id: 'amber',   name: 'Янтарный',      pct: 5,   c: ['#ffe08a','#e8890c'] },
    { id: 'ocean',   name: 'Океан',         pct: 4,   c: ['#4fd1c5','#16508f'] },
    { id: 'violet',  name: 'Фиолетовый',    pct: 3,   c: ['#9f7aea','#44238c'] },
    { id: 'lava',    name: 'Лава',          pct: 2,   c: ['#ff7a45','#8f1010'] },
    { id: 'emerald', name: 'Изумруд',       pct: 0.7, c: ['#34e89e','#0a5c3e'] },
    { id: 'cosmos',  name: 'Космос',        pct: 0.3, c: ['#3a1c71','#0b0b2b'] },
];
const PATTERNS = [
    { id: 'none',     name: 'Без узора',   pct: 40,  symbol: '' },
    { id: 'dots',     name: 'Точки',       pct: 18,  symbol: '· · ·' },
    { id: 'lines',    name: 'Полосы',      pct: 14,  symbol: '━━━' },
    { id: 'diamonds', name: 'Ромбы',       pct: 10,  symbol: '◇◇◇' },
    { id: 'stars',    name: 'Звёзды',      pct: 7,   symbol: '★★★' },
    { id: 'waves',    name: 'Волны',       pct: 5,   symbol: '〰〰' },
    { id: 'hearts',   name: 'Сердечки',   pct: 3,   symbol: '♡♡♡' },
    { id: 'crystals', name: 'Кристаллы',  pct: 2,   symbol: '✦✦✦' },
    { id: 'flames',   name: 'Пламя',      pct: 0.7, symbol: '🔥🔥' },
    { id: 'cosmic',   name: 'Космический',pct: 0.3, symbol: '✨✨✨' },
];
function pickBd() { let r = Math.random() * BACKDROPS.reduce((a,b)=>a+b.pct,0); for (const b of BACKDROPS) { if ((r-=b.pct)<0) return b; } return BACKDROPS[0]; }
function pickPt() { let r = Math.random() * PATTERNS.reduce((a,b)=>a+b.pct,0);  for (const p of PATTERNS)  { if ((r-=p.pct)<0) return p; } return PATTERNS[0]; }

// ─── Crash Game ────────────────────────────────────────────────────────────
// Каждый раунд: коэффициент растёт, в любой момент можно выйти.
// Раунд заканчивается когда самолёт «крашится» (случайный момент).

const CRASH_HOUSE_EDGE = 0.04; // 4% — казино забирает 4% с каждого раунда
let crashState = {
    phase: 'waiting',   // waiting | running | crashed
    multiplier: 1.00,
    crashAt: 1.00,
    roundId: 0,
    bets: [],           // [{uid, amount, nft, cashedOut, cashAt}]
    startAt: null,
    waitUntil: Date.now() + 7000,
};
let crashTimer = null;

function genCrashPoint() {
    // Честный алгоритм: дом выигрывает ~4%.
    // Среднее при равновероятном распределении: E=1/(1-p), где p=HOUSE_EDGE.
    const e = 1 / (1 - CRASH_HOUSE_EDGE);
    const r = Math.random();
    return Math.max(1.00, +(e / r * (1 - CRASH_HOUSE_EDGE)).toFixed(2));
}

function crashBroadcast(type, data = {}) {
    const msg = JSON.stringify({ type: 'crash:' + type, ...data });
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function startWaiting() {
    crashState.phase = 'waiting';
    crashState.bets = [];
    crashState.multiplier = 1.00;
    crashState.roundId++;
    crashState.waitUntil = Date.now() + 7000;
    crashBroadcast('waiting', { roundId: crashState.roundId, waitUntil: crashState.waitUntil });
    crashTimer = setTimeout(startRound, 7000);
}

function startRound() {
    crashState.phase = 'running';
    crashState.crashAt = genCrashPoint();
    crashState.startAt = Date.now();
    crashState.multiplier = 1.00;
    crashBroadcast('start', { roundId: crashState.roundId });
    tickCrash();
}

function tickCrash() {
    if (crashState.phase !== 'running') return;
    const elapsed = (Date.now() - crashState.startAt) / 1000;
    // Экспоненциальный рост: mult = e^(0.06 * t)
    crashState.multiplier = +Math.exp(0.06 * elapsed).toFixed(2);
    if (crashState.multiplier >= crashState.crashAt) {
        doCrash(); return;
    }
    crashBroadcast('tick', { multiplier: crashState.multiplier });
    crashTimer = setTimeout(tickCrash, 200);
}

async function doCrash() {
    crashState.phase = 'crashed';
    crashState.multiplier = crashState.crashAt;
    const users = read(FILES.users);
    const changed = new Set();
    // Все кто не вышел — теряют ставку
    for (const bet of crashState.bets) {
        if (bet.cashedOut) continue;
        if (bet.nft) {
            // NFT-ставка проиграна — просто сгорает
            const gifts = read(FILES.gifts);
            const gi = gifts.findIndex(g => g.id === bet.nftId);
            if (gi !== -1) { gifts.splice(gi, 1); write(FILES.gifts, gifts); }
        }
        // Mars-ставка уже списана при входе в раунд
        changed.add(bet.uid);
    }
    // Сохраняем историю
    const hist = read(FILES.casino);
    hist.unshift({ roundId: crashState.roundId, crashAt: crashState.crashAt, at: new Date().toISOString(),
        bets: crashState.bets.map(b => ({ uid: b.uid, amount: b.amount, cashedOut: b.cashedOut, cashAt: b.cashAt })) });
    if (hist.length > 200) hist.length = 200;
    write(FILES.casino, hist);
    write(FILES.users, users);
    await persist();
    crashBroadcast('crash', {
        crashAt: crashState.crashAt, roundId: crashState.roundId,
        losers: crashState.bets.filter(b => !b.cashedOut).map(b => b.uid),
        winners: crashState.bets.filter(b => b.cashedOut).map(b => ({ uid: b.uid, mult: b.cashAt, profit: b.profit }))
    });
    crashTimer = setTimeout(startWaiting, 4000);
}

// Сделать Mars-ставку в краш
app.post('/api/casino/crash/bet', authMW, async (req, res) => {
    if (crashState.phase !== 'waiting') return res.status(400).json({ error: 'Ставки принимаются только перед стартом раунда' });
    if (crashState.bets.find(b => b.uid === req.uid)) return res.status(400).json({ error: 'Вы уже поставили в этом раунде' });
    const amount = Math.floor(Number(req.body.amount) || 0);
    if (amount < 1) return res.status(400).json({ error: 'Минимальная ставка — 1 Mars' });
    const users = read(FILES.users);
    const u = users.find(x => x.id === req.uid);
    if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
    if ((u.mars || 0) < amount) return res.status(400).json({ error: `Не хватает Mars (у вас ${u.mars || 0})` });
    u.mars -= amount;
    write(FILES.users, users);
    await persist();
    crashState.bets.push({ uid: req.uid, username: u.username, handle: u.handle, avatar: u.avatar || '', amount, cashedOut: false, cashAt: null, profit: 0, nft: false });
    crashBroadcast('bet', { uid: req.uid, username: u.username, amount });
    res.json({ success: true, mars: u.mars });
});

// Сделать NFT-ставку в краш
app.post('/api/casino/crash/bet-nft', authMW, async (req, res) => {
    if (crashState.phase !== 'waiting') return res.status(400).json({ error: 'Ставки принимаются только перед стартом раунда' });
    if (crashState.bets.find(b => b.uid === req.uid)) return res.status(400).json({ error: 'Вы уже поставили в этом раунде' });
    const giftId = String(req.body.giftId || '');
    const gifts = read(FILES.gifts);
    const g = gifts.find(x => x.id === giftId && x.ownerId === req.uid);
    if (!g) return res.status(400).json({ error: 'NFT не найден или не ваш' });
    const item = CATALOG.find(c => c.kind === g.kind);
    if (!item) return res.status(400).json({ error: 'Неизвестный тип NFT' });
    // NFT временно «заморожен» в ставке
    g.frozen = true;
    write(FILES.gifts, gifts);
    await persist();
    crashState.bets.push({ uid: req.uid, username: read(FILES.users).find(u=>u.id===req.uid)?.username || '?',
        amount: item.price, nft: true, nftId: giftId, nftKind: item.kind, nftEmoji: item.emoji, nftName: item.name,
        cashedOut: false, cashAt: null, profit: 0 });
    crashBroadcast('bet', { uid: req.uid, amount: item.price, nft: true, emoji: item.emoji });
    res.json({ success: true });
});

// Cash out
app.post('/api/casino/crash/cashout', authMW, async (req, res) => {
    if (crashState.phase !== 'running') return res.status(400).json({ error: 'Раунд не идёт' });
    const bet = crashState.bets.find(b => b.uid === req.uid && !b.cashedOut);
    if (!bet) return res.status(400).json({ error: 'Нет активной ставки' });
    const mult = crashState.multiplier;
    bet.cashedOut = true; bet.cashAt = mult;
    const users = read(FILES.users);
    const u = users.find(x => x.id === req.uid);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    if (bet.nft) {
        // Выиграл Mars = price * mult, NFT возвращается
        const winMars = Math.floor(bet.amount * mult);
        u.mars = (u.mars || 0) + winMars;
        bet.profit = winMars;
        const gifts = read(FILES.gifts);
        const g = gifts.find(x => x.id === bet.nftId);
        if (g) { g.frozen = false; write(FILES.gifts, gifts); }
    } else {
        const win = Math.floor(bet.amount * mult);
        u.mars = (u.mars || 0) + win;
        bet.profit = win - bet.amount;
    }
    write(FILES.users, users);
    await persist();
    crashBroadcast('cashout', { uid: req.uid, mult, profit: bet.profit });
    res.json({ success: true, mars: u.mars, mult, profit: bet.profit });
});

// ─── NFT Upgrade (казино-версия) ───────────────────────────────────────────
app.post('/api/casino/upgrade', authMW, async (req, res) => {
    const gifts = read(FILES.gifts);
    const g = gifts.find(x => x.id === req.body.giftId && x.ownerId === req.uid && !x.frozen);
    if (!g) return res.status(400).json({ error: 'NFT не найден' });
    const item = CATALOG.find(c => c.kind === g.kind);
    if (!item) return res.status(400).json({ error: 'Неизвестный тип' });
    const cost = Math.max(10, Math.round(item.price * 0.3));
    const users = read(FILES.users);
    const u = users.find(x => x.id === req.uid);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    if ((u.mars || 0) < cost) return res.status(400).json({ error: `Нужно ${cost} Mars, у вас ${u.mars || 0}` });
    u.mars -= cost;
    const oldBd = g.bd, oldPt = g.pt;
    let newBd, newPt, attempts = 0;
    do { newBd = pickBd().id; newPt = pickPt().id; attempts++; } while (attempts < 10 && newBd === oldBd && newPt === oldPt);
    g.bd = newBd; g.pt = newPt; g.upgrades = (g.upgrades || 0) + 1; g.upgradedAt = new Date().toISOString();
    write(FILES.users, users); write(FILES.gifts, gifts);
    await persist();
    const bdInfo = BACKDROPS.find(b => b.id === newBd);
    const ptInfo = PATTERNS.find(p => p.id === newPt);
    res.json({ success: true, mars: u.mars, gift: { ...g, bdName: bdInfo?.name, ptName: ptInfo?.name, bdPct: bdInfo?.pct, ptPct: ptInfo?.pct } });
});

// ─── NFT Crash: ставишь NFT против другого NFT (рандом 50/50 + рандом модель) ──
app.post('/api/casino/nft-duel', authMW, async (req, res) => {
    const gifts = read(FILES.gifts);
    const myGift = gifts.find(x => x.id === req.body.myGiftId && x.ownerId === req.uid && !x.frozen);
    if (!myGift) return res.status(400).json({ error: 'Ваш NFT не найден' });
    const myItem = CATALOG.find(c => c.kind === myGift.kind);
    const mode = req.body.mode; // 'upgrade' | 'double'
    if (!['upgrade', 'double'].includes(mode)) return res.status(400).json({ error: 'Неверный режим' });

    if (mode === 'upgrade') {
        // Платишь 50% стоимости NFT → 50% шанс получить рандомный апгрейд на 1 тир выше
        const tiers = ['common', 'rare', 'epic', 'legendary'];
        const curTier = tiers.indexOf(myItem.rarity);
        if (curTier >= tiers.length - 1) return res.status(400).json({ error: 'NFT уже легендарный — улучшать некуда' });
        const cost = Math.round(myItem.price * 0.5);
        const users = read(FILES.users);
        const u = users.find(x => x.id === req.uid);
        if ((u.mars || 0) < cost) return res.status(400).json({ error: `Нужно ${cost} Mars` });
        u.mars -= cost;
        const win = Math.random() < 0.5;
        if (win) {
            // Повышаем тир — рандомный NFT следующего тира
            const nextTier = tiers[curTier + 1];
            const nextItems = CATALOG.filter(c => c.rarity === nextTier);
            const newItem = nextItems[Math.floor(Math.random() * nextItems.length)];
            const minted = gifts.filter(g => g.kind === newItem.kind).length;
            if (minted >= newItem.supply) { u.mars += cost; write(FILES.users, users); await persist(); return res.status(400).json({ error: 'Целевой NFT распродан, деньги возвращены' }); }
            myGift.kind = newItem.kind; myGift.bd = pickBd().id; myGift.pt = pickPt().id;
            myGift.upgrades = (myGift.upgrades || 0) + 1;
        }
        write(FILES.users, users); write(FILES.gifts, gifts);
        await persist();
        res.json({ success: true, win, mars: u.mars, cost, gift: myGift, newKind: win ? myGift.kind : null,
            newItem: win ? CATALOG.find(c => c.kind === myGift.kind) : null });
    } else {
        // double: ставишь свой NFT против случайного NFT из пула (другой игрок или казино)
        // 50/50: если выигрываешь — получаешь случайный NFT того же тира
        const cost = 0;
        const win = Math.random() < 0.5;
        if (win) {
            const sameRarity = CATALOG.filter(c => c.rarity === myItem.rarity && c.kind !== myItem.kind);
            const prize = sameRarity.length ? sameRarity[Math.floor(Math.random() * sameRarity.length)] : myItem;
            const minted = gifts.filter(g => g.kind === prize.kind).length;
            if (minted < prize.supply) {
                const newGift = { id: 'k_' + crypto.randomUUID(), kind: prize.kind, serial: minted + 1, ownerId: req.uid, fromId: null, price: prize.price, at: new Date().toISOString(), bd: pickBd().id, pt: pickPt().id };
                gifts.push(newGift);
            }
        } else {
            // Проигрыш — теряешь свой NFT
            const gi = gifts.findIndex(x => x.id === myGift.id);
            if (gi !== -1) gifts.splice(gi, 1);
        }
        write(FILES.gifts, gifts);
        await persist();
        res.json({ success: true, win, newKind: win ? myItem.kind : null });
    }
});

// ─── История краш-раундов ──────────────────────────────────────────────────
app.get('/api/casino/history', (req, res) => {
    res.json(read(FILES.casino).slice(0, 50));
});
app.get('/api/casino/state', (req, res) => {
    res.json({ phase: crashState.phase, multiplier: crashState.multiplier, roundId: crashState.roundId, waitUntil: crashState.waitUntil, betsCount: crashState.bets.length });
});

// ─── WebSocket ─────────────────────────────────────────────────────────────
wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'crash:state', phase: crashState.phase, multiplier: crashState.multiplier, roundId: crashState.roundId, waitUntil: crashState.waitUntil }));
    ws.on('error', () => {});
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'casino.html')));

async function init() {
    await loadFromDB();
    server.listen(PORT, () => console.log(`🎰 SAIMON Casino запущен на :${PORT}`));
    startWaiting();
    if (process.env.RENDER_EXTERNAL_URL) {
        setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}), 8 * 60 * 1000);
    }
}
init().catch(console.error);
