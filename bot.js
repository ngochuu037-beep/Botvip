// ============================================================
//  BOT BÁN KEY TỰ ĐỘNG 24/7 - Telegram + SePay (nạp tiền tự động)
//  Biến môi trường (Railway > Variables):
//    BOT_TOKEN       token từ @BotFather
//    OWNER_ID        Telegram ID của bạn (chủ bot, quyền cao nhất)
//    DATABASE_URL    Railway tự thêm khi bạn add PostgreSQL
//    SEPAY_API_KEY   (tuỳ chọn) khoá API SePay mặc định. Có thể dùng lệnh /addapi để thêm
//                    ngay trong bot, /delapi để xoá (khoá trong bot được ưu tiên hơn biến này)
//  Tuỳ chọn: ADMIN_USERNAME, CHANNEL_NAME, CHANNEL_URL, FILE_URL
// ============================================================
const { Telegraf } = require('telegraf');
const pg = require('pg');
const express = require('express');
const crypto = require('crypto');

pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID);
const DATABASE_URL = process.env.DATABASE_URL;
const SEPAY_API_KEY = process.env.SEPAY_API_KEY;
const PORT = process.env.PORT || 3000;
const FIRE_EFFECT = '5104841245755180586'; // hiệu ứng 🔥 (chỉ chat riêng)

if (!BOT_TOKEN || !OWNER_ID || !DATABASE_URL) {
  console.error('Thiếu BOT_TOKEN / OWNER_ID / DATABASE_URL');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});
const bot = new Telegraf(BOT_TOKEN);

// ---------- tiện ích ----------
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (d) =>
  new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
const parseMoney = (s) => {
  const n = Number(String(s || '').replace(/[.,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const btn = (text, data, style) => ({
  text,
  callback_data: data,
  ...(style ? { style } : {}), // style: success=xanh, danger=đỏ, primary=xanh dương (Bot API mới)
});

async function getSetting(k, def = '') {
  const r = await pool.query('SELECT v FROM settings WHERE k=$1', [k]);
  return r.rows.length ? r.rows[0].v : def;
}
async function setSetting(k, v) {
  await pool.query(
    'INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v',
    [k, v]
  );
}
async function isAdmin(id) {
  if (id === OWNER_ID) return true;
  const r = await pool.query('SELECT 1 FROM admins WHERE id=$1', [id]);
  return r.rowCount > 0;
}

// ---------- SePay API key (lưu trong DB, fallback biến môi trường) ----------
async function getSepayKey() {
  return (await getSetting('sepay_api_key', '')) || SEPAY_API_KEY || '';
}
const maskKey = (k) => (k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- duyệt / huỷ tiền nạp ----------
async function notifyAdmins(text, extra) {
  const ids = new Set([OWNER_ID]);
  (await pool.query('SELECT id FROM admins')).rows.forEach((r) => ids.add(Number(r.id)));
  for (const id of ids) bot.telegram.sendMessage(id, text, extra).catch(() => {});
}

// Duyệt: cộng tiền cho user. Chỉ xử lý giao dịch đang 'pending' (không thể duyệt 2 lần).
async function approveDeposit(depId, adminId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const d = (await c.query('SELECT * FROM deposits WHERE id=$1 FOR UPDATE', [depId])).rows[0];
    if (!d) {
      await c.query('ROLLBACK');
      return { err: 'Không tìm thấy giao dịch.' };
    }
    if (d.status !== 'pending') {
      await c.query('ROLLBACK');
      return { err: `Giao dịch #${depId} đã ở trạng thái "${d.status}", không duyệt được.` };
    }
    const u = await c.query(
      `UPDATE users SET balance=balance+$1, total_deposit=total_deposit+$1
       WHERE id=$2 RETURNING balance`,
      [d.amount, d.user_id]
    );
    if (!u.rowCount) {
      await c.query('ROLLBACK');
      return { err: 'Người dùng không tồn tại.' };
    }
    await c.query(
      "UPDATE deposits SET status='approved', handled_by=$1, handled_at=now() WHERE id=$2",
      [adminId, depId]
    );
    await c.query('COMMIT');
    bot.telegram
      .sendMessage(
        d.user_id,
        `✅ <b>Nạp thành công +${money(d.amount)}</b>\n💰 Số dư: <b>${money(u.rows[0].balance)}</b>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return { ok: true, d, balance: u.rows[0].balance };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Huỷ: không cộng tiền. Chỉ xử lý giao dịch đang 'pending'.
async function rejectDeposit(depId, adminId) {
  const r = await pool.query(
    `UPDATE deposits SET status='rejected', handled_by=$1, handled_at=now()
     WHERE id=$2 AND status='pending' RETURNING *`,
    [adminId, depId]
  );
  if (!r.rowCount) {
    const e = await pool.query('SELECT status FROM deposits WHERE id=$1', [depId]);
    return {
      err: e.rowCount
        ? `Giao dịch #${depId} đã ở trạng thái "${e.rows[0].status}", không huỷ được.`
        : 'Không tìm thấy giao dịch.',
    };
  }
  const d = r.rows[0];
  if (d.user_id) {
    bot.telegram
      .sendMessage(
        d.user_id,
        `❌ <b>Giao dịch nạp ${money(d.amount)} đã bị huỷ.</b>\nNếu có nhầm lẫn, vui lòng liên hệ hỗ trợ.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
  return { ok: true, d };
}

// ---------- database ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      username TEXT,
      balance BIGINT NOT NULL DEFAULT 0,
      total_deposit BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admins(id BIGINT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS products(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price BIGINT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS license_keys(
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL,
      key_value TEXT NOT NULL,
      sold BOOLEAN NOT NULL DEFAULT FALSE,
      sold_to BIGINT,
      sold_at TIMESTAMPTZ,
      UNIQUE(product_id, key_value)
    );
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price BIGINT NOT NULL,
      key_value TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS deposits(
      id SERIAL PRIMARY KEY,
      sepay_id TEXT UNIQUE NOT NULL,
      user_id BIGINT,
      amount BIGINT NOT NULL,
      content TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    -- status: approved (đã cộng) | pending (chờ duyệt) | rejected (đã huỷ) | unmatched (không khớp user)
    ALTER TABLE deposits ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
    ALTER TABLE deposits ADD COLUMN IF NOT EXISTS handled_by BIGINT;
    ALTER TABLE deposits ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;
  `);
}

// ---------- menu chính ----------
async function menuText(userId) {
  const u = (await pool.query('SELECT balance,total_deposit FROM users WHERE id=$1', [userId]))
    .rows[0] || { balance: 0, total_deposit: 0 };
  const adminUser = await getSetting('admin_username', process.env.ADMIN_USERNAME || '');
  const defaultNd =
    (adminUser ? `👑 Admin: @${adminUser.replace('@', '')}\n` : '') +
    (process.env.CHANNEL_NAME ? `📣 Kênh: ${process.env.CHANNEL_NAME}` : '');
  const nd = await getSetting('nd', defaultNd);
  const note = await getSetting('note', '');
  return (
    `<b>🤖 BOT BÁN KEY TỰ ĐỘNG 24/7</b>\n\n` +
    (nd ? `${esc(nd)}\n\n` : '') +
    `📊 Tổng nạp: <b>${money(u.total_deposit)}</b>\n` +
    `💰 Số dư: <b>${money(u.balance)}</b>` +
    (note ? `\n\n📝 ${esc(note)}` : '')
  );
}

async function menuKb() {
  const adminUser = (await getSetting('admin_username', process.env.ADMIN_USERNAME || '')).replace('@', '');
  const support = adminUser
    ? { text: '💬 Hỗ trợ / Liên hệ', url: `https://t.me/${adminUser}`, style: 'danger' }
    : btn('💬 Hỗ trợ / Liên hệ', 'support', 'danger');
  const rows = [
    [btn('👤 Tài khoản', 'acc', 'success'), btn('🛍 Cửa hàng', 'shop', 'success')],
    [btn('💳 Nạp tiền', 'nap', 'success'), btn('📊 Lịch sử', 'hist', 'success')],
  ];
  const fileId = await getSetting('file_id', '');
  const fileUrl = await getSetting('file_url', process.env.FILE_URL || '');
  const fileName = await getSetting('file_name', '⬇️ Tải File');
  if (fileId) {
    rows.push([btn(fileName, 'dlfile', 'success')]); // bot gửi file trực tiếp
  } else if (fileUrl) {
    rows.push([{ text: fileName, url: fileUrl, style: 'success' }]); // mở link
  }
  rows.push([support]);
  return rows;
}

async function show(ctx, text, kb) {
  const extra = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: kb },
    link_preview_options: { is_disabled: true },
  };
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (String(e.message).includes('message is not modified')) return;
    await ctx.reply(text, extra);
  }
}

const backKb = [[btn('⬅️ Menu', 'menu')]];

// ---------- middleware: lưu user ----------
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.chat && ctx.chat.type === 'private') {
    await pool.query(
      `INSERT INTO users(id, username) VALUES($1,$2)
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username`,
      [ctx.from.id, ctx.from.username || null]
    );
  }
  return next();
});

// ---------- /start ----------
bot.start(async (ctx) => {
  const text = await menuText(ctx.from.id);
  const kb = await menuKb();
  const extra = { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } };
  try {
    await ctx.reply(text, { ...extra, message_effect_id: FIRE_EFFECT });
  } catch (e) {
    await ctx.reply(text, extra);
  }
});

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await show(ctx, await menuText(ctx.from.id), await menuKb());
});

// ---------- tài khoản ----------
bot.action('acc', async (ctx) => {
  await ctx.answerCbQuery();
  const u = (await pool.query('SELECT * FROM users WHERE id=$1', [ctx.from.id])).rows[0];
  const cnt = (await pool.query('SELECT COUNT(*) AS c FROM orders WHERE user_id=$1', [ctx.from.id]))
    .rows[0].c;
  await show(
    ctx,
    `<b>👤 TÀI KHOẢN</b>\n\n🆔 ID: <code>${u.id}</code>\n` +
      `👤 Username: ${u.username ? '@' + esc(u.username) : '—'}\n` +
      `💰 Số dư: <b>${money(u.balance)}</b>\n📊 Tổng nạp: <b>${money(u.total_deposit)}</b>\n` +
      `🛒 Số đơn đã mua: <b>${cnt}</b>`,
    backKb
  );
});

// ---------- cửa hàng ----------
bot.action('shop', async (ctx) => {
  await ctx.answerCbQuery();
  const r = await pool.query(`
    SELECT p.id, p.name, p.price,
      (SELECT COUNT(*) FROM license_keys k WHERE k.product_id=p.id AND NOT k.sold) AS stock
    FROM products p WHERE p.active ORDER BY p.id`);
  if (!r.rowCount) return show(ctx, '<b>🛍 CỬA HÀNG</b>\n\nChưa có sản phẩm nào.', backKb);
  const kb = r.rows.map((p) => [
    btn(`${p.name} • ${money(p.price)} (còn ${p.stock})`, `p:${p.id}`, 'primary'),
  ]);
  kb.push([btn('⬅️ Menu', 'menu')]);
  await show(ctx, '<b>🛍 CỬA HÀNG</b>\n\nChọn sản phẩm bạn muốn mua:', kb);
});

bot.action(/^p:([A-Za-z0-9_]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const r = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM license_keys k WHERE k.product_id=p.id AND NOT k.sold) AS stock
     FROM products p WHERE p.id=$1 AND p.active`,
    [ctx.match[1]]
  );
  if (!r.rowCount) return show(ctx, 'Sản phẩm không tồn tại.', [[btn('⬅️ Cửa hàng', 'shop')]]);
  const p = r.rows[0];
  const kb = [];
  if (p.stock > 0) kb.push([btn(`✅ Mua ngay - ${money(p.price)}`, `buy:${p.id}`, 'success')]);
  kb.push([btn('⬅️ Cửa hàng', 'shop')]);
  await show(
    ctx,
    `<b>${esc(p.name)}</b>\n\n💵 Giá: <b>${money(p.price)}</b>\n📦 Còn lại: <b>${p.stock}</b>` +
      (p.stock > 0 ? '' : '\n\n❌ Tạm hết hàng.'),
    kb
  );
});

async function buy(userId, pid) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    const p = (await c.query('SELECT * FROM products WHERE id=$1 AND active', [pid])).rows[0];
    if (!p) {
      await c.query('ROLLBACK');
      return { err: 'Sản phẩm không tồn tại.' };
    }
    if (u.balance < p.price) {
      await c.query('ROLLBACK');
      return {
        err: `Số dư không đủ.\nCần: ${money(p.price)}\nBạn có: ${money(u.balance)}`,
        needTopup: true,
      };
    }
    const k = (
      await c.query(
        `SELECT id, key_value FROM license_keys
         WHERE product_id=$1 AND NOT sold ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [pid]
      )
    ).rows[0];
    if (!k) {
      await c.query('ROLLBACK');
      return { err: 'Sản phẩm vừa hết hàng.' };
    }
    await c.query('UPDATE license_keys SET sold=TRUE, sold_to=$1, sold_at=now() WHERE id=$2', [
      userId,
      k.id,
    ]);
    const nu = (
      await c.query('UPDATE users SET balance=balance-$1 WHERE id=$2 RETURNING balance', [
        p.price,
        userId,
      ])
    ).rows[0];
    await c.query(
      'INSERT INTO orders(user_id,product_id,product_name,price,key_value) VALUES($1,$2,$3,$4,$5)',
      [userId, p.id, p.name, p.price, k.key_value]
    );
    await c.query('COMMIT');
    return { ok: true, key: k.key_value, product: p, balance: nu.balance };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

bot.action(/^buy:([A-Za-z0-9_]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const r = await buy(ctx.from.id, ctx.match[1]);
  if (r.err) {
    const kb = [];
    if (r.needTopup) kb.push([btn('💳 Nạp tiền', 'nap', 'success')]);
    kb.push([btn('⬅️ Cửa hàng', 'shop')]);
    return show(ctx, `❌ ${esc(r.err)}`, kb);
  }
  await show(
    ctx,
    `<b>✅ MUA THÀNH CÔNG</b>\n\n📦 ${esc(r.product.name)}\n💵 Giá: ${money(r.product.price)}\n\n` +
      `🔑 Key của bạn (chạm để sao chép):\n<code>${esc(r.key)}</code>\n\n💰 Số dư còn: <b>${money(r.balance)}</b>`,
    [[btn('🛍 Mua tiếp', 'shop', 'success')], [btn('⬅️ Menu', 'menu')]]
  );
});

// ---------- nạp tiền ----------
bot.action('nap', async (ctx) => {
  await ctx.answerCbQuery();
  const amounts = [20000, 50000, 100000, 200000, 500000];
  const kb = [];
  for (let i = 0; i < amounts.length; i += 2) {
    kb.push(amounts.slice(i, i + 2).map((a) => btn(money(a), `nap:${a}`, 'primary')));
  }
  kb.push([btn('✏️ Số tiền khác', 'nap:0')]);
  kb.push([btn('⬅️ Menu', 'menu')]);
  await show(ctx, '<b>💳 NẠP TIỀN</b>\n\nChọn số tiền muốn nạp:', kb);
});

bot.action(/^nap:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const amount = Number(ctx.match[1]);
  const content = `NAP${ctx.from.id}`;
  const manual = (await getSetting('deposit_mode', 'auto')) === 'manual';
  const bank = await getSetting('bank', '');
  const acc = await getSetting('acc', '');
  const accName = await getSetting('acc_name', '');
  const qrId = await getSetting('qr_file_id', '');

  const caption =
    `<b>💳 NẠP TIỀN</b>\n\n` +
    (bank ? `🏦 Ngân hàng: <b>${esc(bank)}</b>\n` : '') +
    (acc ? `🔢 STK: <code>${esc(acc)}</code>\n` : '') +
    (accName ? `👤 Chủ TK: <b>${esc(accName)}</b>\n` : '') +
    (amount ? `💵 Số tiền: <b>${money(amount)}</b>\n` : '') +
    `📝 Nội dung: <code>${content}</code>\n\n` +
    (manual
      ? `⚠️ Chuyển <b>đúng nội dung</b>, tiền sẽ được cộng sau khi admin duyệt.`
      : `⚠️ Chuyển <b>đúng nội dung</b>, tiền được cộng tự động sau 1–2 phút.`);
  const extra = {
    parse_mode: 'HTML',
    caption,
    reply_markup: { inline_keyboard: backKb },
  };

  try {
    if (qrId) {
      await ctx.replyWithPhoto(qrId, extra);
    } else if (bank && acc) {
      const url =
        `https://qr.sepay.vn/img?acc=${encodeURIComponent(acc)}&bank=${encodeURIComponent(bank)}` +
        (amount ? `&amount=${amount}` : '') +
        `&des=${encodeURIComponent(content)}`;
      await ctx.replyWithPhoto({ url }, extra);
    } else {
      await ctx.reply('⚠️ Admin chưa cài thông tin nhận tiền. Vui lòng liên hệ hỗ trợ.', {
        reply_markup: { inline_keyboard: backKb },
      });
    }
  } catch (e) {
    console.error('QR lỗi:', e.message);
    await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: backKb } });
  }
});

// ---------- lịch sử ----------
bot.action('hist', async (ctx) => {
  await ctx.answerCbQuery();
  const o = await pool.query(
    'SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 10',
    [ctx.from.id]
  );
  const d = await pool.query(
    'SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 5',
    [ctx.from.id]
  );
  let text = '<b>📊 LỊCH SỬ</b>\n';
  text += '\n<b>🛒 Đơn mua gần đây:</b>\n';
  text += o.rowCount
    ? o.rows
        .map(
          (r) =>
            `• ${fmtTime(r.created_at)}\n  ${esc(r.product_name)} - ${money(r.price)}\n  <code>${esc(r.key_value)}</code>`
        )
        .join('\n')
    : 'Chưa có đơn nào.';
  text += '\n\n<b>💳 Nạp tiền gần đây:</b>\n';
  text += d.rowCount
    ? d.rows
        .map((r) => {
          const tag =
            r.status === 'pending' ? ' ⏳ chờ duyệt' : r.status === 'rejected' ? ' ❌ đã huỷ' : '';
          return `• ${fmtTime(r.created_at)} +${money(r.amount)}${tag}`;
        })
        .join('\n')
    : 'Chưa có giao dịch nạp.';
  await show(ctx, text, backKb);
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery('Admin chưa cài liên hệ', { show_alert: true });
});

// ============================================================
//  LỆNH ADMIN
// ============================================================
const argsOf = (ctx) => (ctx.message.text || '').replace(/^\/\S+\s*/, '');
function adminCmd(name, fn, ownerOnly = false) {
  bot.command(name, async (ctx) => {
    const allowed = ownerOnly ? ctx.from.id === OWNER_ID : await isAdmin(ctx.from.id);
    if (!allowed) return;
    try {
      await fn(ctx, argsOf(ctx));
    } catch (e) {
      console.error(e);
      await ctx.reply('❌ Lỗi: ' + e.message);
    }
  });
}

adminCmd('admin', async (ctx) => {
  await ctx.reply(
    `<b>🛠 LỆNH ADMIN</b>\n\n` +
      `<b>Giao diện</b>\n` +
      `/setnd NỘI DUNG — sửa nội dung trang chủ (gõ /setnd reset để về mặc định)\n` +
      `/setnote GHI CHÚ — thêm ghi chú dưới trang chủ (/setnote xoa để xoá)\n` +
      `/setadmin USERNAME — username nút Hỗ trợ\n\n` +
      `<b>Nạp tiền / QR</b>\n` +
      `/setbank NGÂNHÀNG STK TÊN CHỦ TK — VD: /setbank MBBank 0123456789 NGUYEN VAN A\n` +
      `/setqr — gửi ảnh QR kèm chú thích /setqr (hoặc reply ảnh bằng /setqr)\n` +
      `/delqr — xoá QR ảnh, dùng QR tự tạo\n\n` +
      `<b>Nút Tải File</b>\n` +
      `/setfile LINK | TÊN NÚT — đặt link tải (tên nút không bắt buộc)\n` +
      `/setfile — gửi file kèm chú thích /setfile (hoặc reply file) để bot gửi file trực tiếp\n` +
      `/setfilename TÊN — đổi tên nút • /delfile — xoá nút\n\n` +
      `<b>SePay API</b>\n` +
      `/addapi KEY — thêm/đổi API key SePay (chỉ chủ bot)\n` +
      `/delapi — xoá API key SePay (chỉ chủ bot)\n` +
      `/api — xem trạng thái API key\n\n` +
      `<b>Duyệt tiền nạp</b>\n` +
      `/setduyet tay|auto — tay: nạp xong phải duyệt • auto: tự cộng\n` +
      `/cho — danh sách giao dịch chờ duyệt\n` +
      `/ls [cho|duyet|huy] — lịch sử nạp tiền (20 giao dịch gần nhất)\n` +
      `/duyet ID — duyệt (cộng tiền) • /huy ID — huỷ giao dịch\n\n` +
      `<b>Sản phẩm</b>\n` +
      `/sp — xem danh sách &amp; tồn kho\n` +
      `/addsp ID | TÊN | GIÁ\n` +
      `/setname ID | TÊN MỚI\n` +
      `/setprice ID | GIÁ MỚI\n` +
      `/delsp ID — ẩn sản phẩm\n` +
      `/addkey ID rồi mỗi dòng 1 key\n\n` +
      `<b>Người dùng</b>\n` +
      `/cong ID SỐTIỀN — cộng tiền (số âm để trừ)\n` +
      `/tb ID NỘI DUNG — gửi thông báo riêng\n` +
      `/tball NỘI DUNG — gửi cho tất cả người dùng\n\n` +
      `<b>Chủ bot</b>\n/addadmin ID • /deladmin ID`,
    { parse_mode: 'HTML' }
  );
});

adminCmd('setnd', async (ctx, a) => {
  if (!a) return ctx.reply('Cú pháp: /setnd NỘI DUNG\n(hoặc /setnd reset)');
  if (a.toLowerCase() === 'reset') {
    await pool.query("DELETE FROM settings WHERE k='nd'");
    return ctx.reply('✅ Đã về nội dung mặc định.');
  }
  await setSetting('nd', a);
  await ctx.reply('✅ Đã sửa nội dung trang chủ.');
});

adminCmd('setnote', async (ctx, a) => {
  if (!a) return ctx.reply('Cú pháp: /setnote GHI CHÚ\n(hoặc /setnote xoa)');
  if (a.toLowerCase() === 'xoa') {
    await pool.query("DELETE FROM settings WHERE k='note'");
    return ctx.reply('✅ Đã xoá ghi chú.');
  }
  await setSetting('note', a);
  await ctx.reply('✅ Đã cập nhật ghi chú.');
});

adminCmd('setadmin', async (ctx, a) => {
  const u = a.replace('@', '').trim();
  if (!u) return ctx.reply('Cú pháp: /setadmin USERNAME');
  await setSetting('admin_username', u);
  await ctx.reply('✅ Đã đặt username hỗ trợ: @' + u);
});

adminCmd('setbank', async (ctx, a) => {
  const p = a.split(/\s+/).filter(Boolean);
  if (p.length < 2) return ctx.reply('Cú pháp: /setbank NGÂNHÀNG STK TÊN CHỦ TK');
  await setSetting('bank', p[0]);
  await setSetting('acc', p[1]);
  await setSetting('acc_name', p.slice(2).join(' '));
  await ctx.reply(
    `✅ Đã lưu: ${p[0]} - ${p[1]}${p.length > 2 ? ' - ' + p.slice(2).join(' ') : ''}\n` +
      `Nếu chưa gửi QR ảnh riêng, bot sẽ tự tạo QR theo thông tin này.`
  );
});

adminCmd('setqr', async (ctx) => {
  if (ctx.message.photo) return; // trường hợp ảnh kèm chú thích do bot.on('photo') xử lý
  const r = ctx.message.reply_to_message;
  if (r && r.photo) {
    await setSetting('qr_file_id', r.photo[r.photo.length - 1].file_id);
    return ctx.reply('✅ Đã đổi mã QR.');
  }
  await ctx.reply('Gửi ảnh QR kèm chú thích /setqr, hoặc reply vào ảnh QR rồi gõ /setqr');
});

bot.on('photo', async (ctx) => {
  const cap = ctx.message.caption || '';
  if (!/^\/setqr(@\w+)?(\s|$)/i.test(cap)) return;
  if (!(await isAdmin(ctx.from.id))) return;
  const ph = ctx.message.photo;
  await setSetting('qr_file_id', ph[ph.length - 1].file_id);
  await ctx.reply('✅ Đã đổi mã QR.');
});

adminCmd('delqr', async (ctx) => {
  await pool.query("DELETE FROM settings WHERE k='qr_file_id'");
  await ctx.reply('✅ Đã xoá QR ảnh. Bot sẽ dùng QR tự tạo (nếu đã /setbank).');
});

adminCmd('sp', async (ctx) => {
  const r = await pool.query(`
    SELECT p.id, p.name, p.price, p.active,
      (SELECT COUNT(*) FROM license_keys k WHERE k.product_id=p.id AND NOT k.sold) AS stock
    FROM products p ORDER BY p.id`);
  if (!r.rowCount) return ctx.reply('Chưa có sản phẩm. Dùng /addsp ID | TÊN | GIÁ');
  await ctx.reply(
    r.rows
      .map((p) => `${p.active ? '🟢' : '⚪️'} ${p.id} | ${p.name} | ${money(p.price)} | còn ${p.stock}`)
      .join('\n')
  );
});

adminCmd('addsp', async (ctx, a) => {
  const [id, name, priceRaw] = a.split('|').map((s) => (s || '').trim());
  const price = parseMoney(priceRaw);
  if (!/^[A-Za-z0-9_]{1,20}$/.test(id || '') || !name || !(price >= 0)) {
    return ctx.reply('Cú pháp: /addsp ID | TÊN | GIÁ\nVD: /addsp key7d | Key 7 ngày | 50000\n(ID chỉ gồm chữ/số/_ tối đa 20 ký tự)');
  }
  const r = await pool.query(
    'INSERT INTO products(id,name,price) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING',
    [id, name, price]
  );
  if (!r.rowCount) return ctx.reply('❌ ID này đã tồn tại.');
  await ctx.reply(`✅ Đã thêm ${name} (${money(price)}). Thêm key bằng /addkey ${id}`);
});

adminCmd('setname', async (ctx, a) => {
  const [id, name] = a.split('|').map((s) => (s || '').trim());
  if (!id || !name) return ctx.reply('Cú pháp: /setname ID | TÊN MỚI');
  const r = await pool.query('UPDATE products SET name=$1 WHERE id=$2', [name, id]);
  await ctx.reply(r.rowCount ? `✅ Đã đổi tên thành: ${name}` : '❌ Không tìm thấy ID.');
});

adminCmd('setprice', async (ctx, a) => {
  const [id, priceRaw] = a.split('|').map((s) => (s || '').trim());
  const price = parseMoney(priceRaw);
  if (!id || !(price >= 0)) return ctx.reply('Cú pháp: /setprice ID | GIÁ MỚI');
  const r = await pool.query('UPDATE products SET price=$1 WHERE id=$2', [price, id]);
  await ctx.reply(r.rowCount ? `✅ Giá mới: ${money(price)}` : '❌ Không tìm thấy ID.');
});

adminCmd('delsp', async (ctx, a) => {
  const id = a.trim();
  const r = await pool.query('UPDATE products SET active=FALSE WHERE id=$1', [id]);
  await ctx.reply(r.rowCount ? '✅ Đã ẩn sản phẩm.' : '❌ Không tìm thấy ID.');
});

adminCmd('addkey', async (ctx, a) => {
  const m = a.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return ctx.reply('Cú pháp:\n/addkey ID\nkey1\nkey2\nkey3');
  const pid = m[1];
  const body = m[2];
  const keys = (body.includes('\n') ? body.split(/\r?\n/) : body.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keys.length) return ctx.reply('Chưa có key nào. Mỗi dòng 1 key.');
  const p = await pool.query('SELECT 1 FROM products WHERE id=$1', [pid]);
  if (!p.rowCount) return ctx.reply('❌ Không tìm thấy sản phẩm. Dùng /sp để xem ID.');
  const r = await pool.query(
    `INSERT INTO license_keys(product_id, key_value)
     SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [pid, keys]
  );
  await ctx.reply(`✅ Đã thêm ${r.rowCount}/${keys.length} key (key trùng sẽ bị bỏ qua).`);
});

adminCmd('cong', async (ctx, a) => {
  const [idRaw, amtRaw] = a.split(/\s+/);
  const id = Number(idRaw);
  const amt = Number(String(amtRaw || '').replace(/[.,]/g, ''));
  if (!Number.isInteger(id) || !Number.isFinite(amt) || amt === 0) {
    return ctx.reply('Cú pháp: /cong ID SỐTIỀN\nVD: /cong 123456789 50000 (số âm để trừ)');
  }
  const r = await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING balance', [
    amt,
    id,
  ]);
  if (!r.rowCount) return ctx.reply('❌ Người dùng chưa từng /start bot.');
  await ctx.reply(`✅ ${amt > 0 ? 'Đã cộng' : 'Đã trừ'} ${money(Math.abs(amt))}. Số dư mới: ${money(r.rows[0].balance)}`);
  bot.telegram
    .sendMessage(
      id,
      `${amt > 0 ? '💰 Admin đã cộng' : '➖ Admin đã trừ'} <b>${money(Math.abs(amt))}</b> vào tài khoản.\nSố dư hiện tại: <b>${money(r.rows[0].balance)}</b>`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});
});

adminCmd('tb', async (ctx, a) => {
  const m = a.match(/^(\d+)\s+([\s\S]+)$/);
  if (!m) return ctx.reply('Cú pháp: /tb ID NỘI DUNG');
  try {
    await bot.telegram.sendMessage(Number(m[1]), `📢 <b>Thông báo</b>\n\n${esc(m[2])}`, {
      parse_mode: 'HTML',
    });
    await ctx.reply('✅ Đã gửi.');
  } catch (e) {
    await ctx.reply('❌ Không gửi được (người dùng chặn bot hoặc sai ID).');
  }
});

adminCmd('tball', async (ctx, a) => {
  if (!a) return ctx.reply('Cú pháp: /tball NỘI DUNG');
  const ids = (await pool.query('SELECT id FROM users')).rows.map((r) => r.id);
  await ctx.reply(`⏳ Đang gửi cho ${ids.length} người...`);
  const adminId = ctx.from.id;
  (async () => {
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await bot.telegram.sendMessage(id, `📢 <b>Thông báo</b>\n\n${esc(a)}`, { parse_mode: 'HTML' });
        ok++;
      } catch (e) {
        const wait = e.response && e.response.parameters && e.response.parameters.retry_after;
        if (wait) {
          await sleep((wait + 1) * 1000);
          try {
            await bot.telegram.sendMessage(id, `📢 <b>Thông báo</b>\n\n${esc(a)}`, { parse_mode: 'HTML' });
            ok++;
            continue;
          } catch (_) {}
        }
        fail++;
      }
      await sleep(50);
    }
    bot.telegram.sendMessage(adminId, `✅ Gửi xong: ${ok} thành công, ${fail} lỗi.`).catch(() => {});
  })();
});

adminCmd(
  'addadmin',
  async (ctx, a) => {
    const id = Number(a.trim());
    if (!Number.isInteger(id)) return ctx.reply('Cú pháp: /addadmin ID');
    await pool.query('INSERT INTO admins(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    await ctx.reply('✅ Đã thêm admin ' + id);
  },
  true
);

adminCmd(
  'deladmin',
  async (ctx, a) => {
    const id = Number(a.trim());
    if (!Number.isInteger(id)) return ctx.reply('Cú pháp: /deladmin ID');
    const r = await pool.query('DELETE FROM admins WHERE id=$1', [id]);
    await ctx.reply(r.rowCount ? '✅ Đã huỷ admin ' + id : '❌ ID này không phải admin.');
  },
  true
);

// ---------- SePay API: thêm / xoá / xem ----------
adminCmd(
  'addapi',
  async (ctx, a) => {
    const key = a.trim();
    // xoá tin nhắn chứa key cho an toàn
    ctx.deleteMessage().catch(() => {});
    if (!key || /\s/.test(key) || key.length < 8) {
      return ctx.reply('Cú pháp: /addapi KEY\n(KEY là API key bạn đặt trong webhook SePay, tối thiểu 8 ký tự, không chứa khoảng trắng)');
    }
    await setSetting('sepay_api_key', key);
    await ctx.reply(`✅ Đã lưu API SePay: <code>${esc(maskKey(key))}</code>\nTin nhắn chứa key đã được xoá. Webhook dùng key mới ngay, không cần restart.`, {
      parse_mode: 'HTML',
    });
  },
  true
);

adminCmd(
  'delapi',
  async (ctx) => {
    const r = await pool.query("DELETE FROM settings WHERE k='sepay_api_key'");
    const envKey = SEPAY_API_KEY;
    if (!r.rowCount && !envKey) return ctx.reply('ℹ️ Chưa có API SePay nào để xoá.');
    await ctx.reply(
      (r.rowCount ? '✅ Đã xoá API SePay.' : 'ℹ️ Không có key lưu trong bot.') +
        (envKey
          ? '\n⚠️ Biến môi trường SEPAY_API_KEY trên Railway vẫn còn nên webhook vẫn nhận key đó. Xoá biến này trên Railway để tắt hẳn.'
          : '\nWebhook SePay sẽ từ chối mọi yêu cầu cho tới khi bạn /addapi key mới (nạp tiền tự động tạm tắt).')
    );
  },
  true
);

adminCmd('api', async (ctx) => {
  const dbKey = await getSetting('sepay_api_key', '');
  await ctx.reply(
    '<b>🔑 API SePay</b>\n' +
      `Key trong bot: ${dbKey ? '<code>' + esc(maskKey(dbKey)) + '</code>' : 'chưa có'}\n` +
      `Key biến môi trường: ${SEPAY_API_KEY ? 'có' : 'không'}\n` +
      `Đang dùng: <b>${dbKey ? 'key trong bot' : SEPAY_API_KEY ? 'biến môi trường' : 'chưa có (webhook đang tắt)'}</b>`,
    { parse_mode: 'HTML' }
  );
});

// ---------- chế độ duyệt tiền nạp ----------
adminCmd('setduyet', async (ctx, a) => {
  const m = a.trim().toLowerCase();
  if (!['tay', 'auto'].includes(m)) {
    const cur = (await getSetting('deposit_mode', 'auto')) === 'manual' ? 'tay' : 'auto';
    return ctx.reply(`Cú pháp: /setduyet tay|auto\nHiện tại: ${cur}\n• tay: tiền nạp phải được admin duyệt mới cộng\n• auto: tiền nạp tự cộng`);
  }
  await setSetting('deposit_mode', m === 'tay' ? 'manual' : 'auto');
  await ctx.reply(m === 'tay' ? '✅ Đã bật duyệt tay: tiền nạp sẽ chờ admin duyệt/huỷ.' : '✅ Đã bật tự động cộng tiền nạp.');
});

adminCmd('cho', async (ctx) => {
  const r = await pool.query(
    `SELECT d.id, d.amount, d.content, d.created_at, d.user_id, u.username
     FROM deposits d LEFT JOIN users u ON u.id=d.user_id
     WHERE d.status='pending' ORDER BY d.id LIMIT 20`
  );
  if (!r.rowCount) return ctx.reply('✅ Không có giao dịch nào chờ duyệt.');
  for (const d of r.rows) {
    await ctx.reply(depText(d), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: depKb(d.id) },
    });
  }
});

adminCmd('duyet', async (ctx, a) => {
  const id = Number(a.trim());
  if (!Number.isInteger(id)) return ctx.reply('Cú pháp: /duyet ID  (ID xem ở /cho)');
  const r = await approveDeposit(id, ctx.from.id);
  if (r.err) return ctx.reply('❌ ' + r.err);
  await ctx.reply(`✅ Đã duyệt #${id}: +${money(r.d.amount)} cho ${r.d.user_id}. Số dư mới: ${money(r.balance)}`);
});

adminCmd('huy', async (ctx, a) => {
  const id = Number(a.trim());
  if (!Number.isInteger(id)) return ctx.reply('Cú pháp: /huy ID  (ID xem ở /cho)');
  const r = await rejectDeposit(id, ctx.from.id);
  if (r.err) return ctx.reply('❌ ' + r.err);
  await ctx.reply(`✅ Đã huỷ giao dịch #${id} (${money(r.d.amount)}).`);
});

// ---------- lịch sử nạp tiền ----------
adminCmd('ls', async (ctx, a) => {
  const map = { cho: 'pending', duyet: 'approved', huy: 'rejected' };
  const f = map[a.trim().toLowerCase()];
  const r = await pool.query(
    `SELECT d.id, d.amount, d.status, d.created_at, d.user_id, u.username
     FROM deposits d LEFT JOIN users u ON u.id=d.user_id
     ${f ? 'WHERE d.status=$1' : ''} ORDER BY d.id DESC LIMIT 20`,
    f ? [f] : []
  );
  if (!r.rowCount) return ctx.reply('Chưa có giao dịch nào.');
  const label = { pending: '⏳ chờ', approved: '✅ duyệt', rejected: '❌ huỷ', unmatched: '⚠️ không khớp' };
  await ctx.reply(
    `<b>📋 LỊCH SỬ NẠP${f ? ' (' + a.trim().toLowerCase() + ')' : ''}</b>\n\n` +
      r.rows
        .map(
          (d) =>
            `#${d.id} • ${fmtTime(d.created_at)}\n   ${d.username ? '@' + esc(d.username) : d.user_id || '—'} • <b>${money(d.amount)}</b> • ${label[d.status] || d.status}`
        )
        .join('\n'),
    { parse_mode: 'HTML' }
  );
});

// ---------- sửa nút Tải File ----------
adminCmd('setfile', async (ctx, a) => {
  const rp = ctx.message.reply_to_message;
  if (rp && rp.document) {
    await setSetting('file_id', rp.document.file_id);
    return ctx.reply('✅ Đã đặt file tải. Người dùng bấm nút sẽ nhận file trực tiếp.');
  }
  const [url, name] = a.split('|').map((x) => (x || '').trim());
  if (!/^https?:\/\//i.test(url || '')) {
    return ctx.reply('Cú pháp: /setfile LINK | TÊN NÚT (tên nút không bắt buộc)\nHoặc gửi file kèm chú thích /setfile, hoặc reply vào file rồi gõ /setfile');
  }
  await setSetting('file_url', url);
  await pool.query("DELETE FROM settings WHERE k='file_id'"); // link thay cho file đã gửi
  if (name) await setSetting('file_name', name);
  await ctx.reply('✅ Đã đặt link tải: ' + url);
});

bot.on('document', async (ctx) => {
  const cap = ctx.message.caption || '';
  if (!/^\/setfile(@\w+)?(\s|$)/i.test(cap)) return;
  if (!(await isAdmin(ctx.from.id))) return;
  await setSetting('file_id', ctx.message.document.file_id);
  await ctx.reply('✅ Đã đặt file tải. Người dùng bấm nút sẽ nhận file trực tiếp.');
});

adminCmd('setfilename', async (ctx, a) => {
  if (!a) return ctx.reply('Cú pháp: /setfilename TÊN NÚT');
  await setSetting('file_name', a);
  await ctx.reply('✅ Đã đổi tên nút: ' + a);
});

adminCmd('delfile', async (ctx) => {
  await pool.query("DELETE FROM settings WHERE k IN ('file_id','file_url','file_name')");
  await ctx.reply(
    '✅ Đã xoá nút Tải File.' +
      (process.env.FILE_URL ? '\n⚠️ Biến FILE_URL trên Railway vẫn còn nên nút vẫn hiện, hãy xoá biến đó.' : '')
  );
});

bot.action('dlfile', async (ctx) => {
  await ctx.answerCbQuery();
  const id = await getSetting('file_id', '');
  if (!id) return ctx.reply('File chưa có. Vui lòng liên hệ hỗ trợ.');
  await ctx.replyWithDocument(id).catch(() => ctx.reply('❌ Không gửi được file.'));
});

// nút bấm ✅ Duyệt / ❌ Huỷ trong tin nhắn thông báo
const depText = (d) =>
  `🔔 <b>Nạp tiền chờ duyệt #${d.id}</b>\n` +
  `👤 ${d.username ? '@' + esc(d.username) + ' ' : ''}(<code>${d.user_id}</code>)\n` +
  `💵 Số tiền: <b>${money(d.amount)}</b>\n📝 Nội dung: <code>${esc(d.content)}</code>\n` +
  `🕒 ${fmtTime(d.created_at)}`;
const depKb = (id) => [[btn('✅ Duyệt', `dep_ok:${id}`, 'success'), btn('❌ Huỷ', `dep_no:${id}`, 'danger')]];

bot.action(/^dep_(ok|no):(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx.from.id))) return ctx.answerCbQuery('Bạn không có quyền.', { show_alert: true });
  const id = Number(ctx.match[2]);
  const r =
    ctx.match[1] === 'ok' ? await approveDeposit(id, ctx.from.id) : await rejectDeposit(id, ctx.from.id);
  if (r.err) {
    await ctx.answerCbQuery(r.err, { show_alert: true });
    return;
  }
  await ctx.answerCbQuery(ctx.match[1] === 'ok' ? 'Đã duyệt' : 'Đã huỷ');
  const who = esc(ctx.from.username ? '@' + ctx.from.username : String(ctx.from.id));
  const old = (ctx.callbackQuery.message && ctx.callbackQuery.message.text) || `Giao dịch #${id}`;
  await ctx
    .editMessageText(
      `${esc(old)}\n\n${ctx.match[1] === 'ok' ? '✅ ĐÃ DUYỆT' : '❌ ĐÃ HUỶ'} bởi ${who}`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});
});

bot.catch((err) => console.error('Bot error:', err));

// ============================================================
//  WEBHOOK SEPAY (nạp tiền tự động)
// ============================================================
const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.send('ok'));

app.post('/sepay', async (req, res) => {
  let key;
  try {
    key = await getSepayKey();
  } catch (e) {
    console.error('Đọc API key lỗi:', e);
    return res.status(500).json({ success: false });
  }
  const auth = req.headers['authorization'] || '';
  if (!key || !safeEq(auth, `Apikey ${key}`)) {
    return res.status(401).json({ success: false });
  }
  const d = req.body || {};
  if (d.transferType !== 'in') return res.json({ success: true });

  const amount = Number(d.transferAmount);
  const sid = String(d.id ?? d.referenceCode ?? '');
  const content = String(d.content || d.description || '');
  if (!sid || !(amount > 0)) return res.status(400).json({ success: false });

  const m = content.match(/NAP(\d{5,15})/i);
  const uid = m ? Number(m[1]) : null;
  const manual = (await getSetting('deposit_mode', 'auto')) === 'manual';

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // manual + khớp user => 'pending' (chờ admin duyệt), còn lại => 'approved'
    const ins = await c.query(
      `INSERT INTO deposits(sepay_id, user_id, amount, content, status) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (sepay_id) DO NOTHING RETURNING id`,
      [sid, uid, amount, content, manual && uid ? 'pending' : 'approved']
    );
    if (!ins.rowCount) {
      await c.query('ROLLBACK'); // giao dịch đã xử lý rồi, không cộng lại
      return res.json({ success: true });
    }
    const depId = ins.rows[0].id;

    // ----- chế độ duyệt tay: chưa cộng tiền, báo admin duyệt/huỷ -----
    if (manual && uid) {
      const ur = await c.query('SELECT username FROM users WHERE id=$1', [uid]);
      if (!ur.rowCount) {
        await c.query("UPDATE deposits SET status='unmatched' WHERE id=$1", [depId]);
        await c.query('COMMIT');
        bot.telegram
          .sendMessage(OWNER_ID, `⚠️ Có tiền vào nhưng người dùng ${uid} chưa /start bot:\n${money(amount)}\nNội dung: ${content}\nDùng /cong ID SỐTIỀN để cộng tay.`)
          .catch(() => {});
        return res.json({ success: true });
      }
      await c.query('COMMIT');
      const dep = { id: depId, user_id: uid, username: ur.rows[0].username, amount, content, created_at: new Date() };
      notifyAdmins(depText(dep), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: depKb(depId) },
      }).catch(() => {});
      bot.telegram
        .sendMessage(uid, `⏳ Đã nhận giao dịch <b>${money(amount)}</b>, đang chờ admin duyệt.`, { parse_mode: 'HTML' })
        .catch(() => {});
      return res.json({ success: true });
    }

    // ----- chế độ tự động: cộng tiền ngay -----
    let balance = null;
    if (uid) {
      const r = await c.query(
        `UPDATE users SET balance=balance+$1, total_deposit=total_deposit+$1
         WHERE id=$2 RETURNING balance`,
        [amount, uid]
      );
      if (r.rowCount) balance = r.rows[0].balance;
    }
    if (balance === null) {
      await c.query("UPDATE deposits SET status='unmatched' WHERE id=$1", [depId]);
    }
    await c.query('COMMIT');

    if (balance !== null) {
      bot.telegram
        .sendMessage(
          uid,
          `✅ <b>Nạp thành công +${money(amount)}</b>\n💰 Số dư: <b>${money(balance)}</b>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } else {
      bot.telegram
        .sendMessage(
          OWNER_ID,
          `⚠️ Có tiền vào nhưng không khớp người dùng:\n${money(amount)}\nNội dung: ${content}\nDùng /cong ID SỐTIỀN để cộng tay.`
        )
        .catch(() => {});
    }
    res.json({ success: true });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('Webhook lỗi:', e);
    res.status(500).json({ success: false });
  } finally {
    c.release();
  }
});

// ---------- chạy ----------
(async () => {
  await initDb();
  app.listen(PORT, () => console.log('Web server chạy cổng', PORT));
  bot.launch().catch((e) => {
    console.error('Không chạy được bot:', e);
    process.exit(1);
  });
  console.log('Bot đã chạy');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
