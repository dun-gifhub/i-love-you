import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ---------- Ket noi co so du lieu ----------
   Neu co TURSO_DATABASE_URL: du lieu nam tren Turso (mien phi, qua mang),
   dung duoc tren Render goi free vi khong can o dia rieng.
   Neu khong: dung file SQLite ngay tren may (chay o may ca nhan). */
let client;
if (process.env.TURSO_DATABASE_URL) {
  client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
} else {
  const file = process.env.DB_PATH
    ? resolve(process.env.DB_PATH)
    : resolve(process.cwd(), "data/thu-vien.db");
  mkdirSync(dirname(file), { recursive: true });
  client = createClient({ url: `file:${file}` });
}

export const db = client;

/** Chay mot cau lenh SQL co tham so, tra ve ResultSet cua libsql. */
async function run(sql, args = []) {
  return client.execute({ sql, args });
}
/** Nhu run(), nhung tra ve mang cac dong (hang ket qua). */
async function all(sql, args = []) {
  return (await run(sql, args)).rows;
}
/** Nhu run(), nhung chi tra ve dong dau tien (hoac undefined). */
async function one(sql, args = []) {
  return (await run(sql, args)).rows[0];
}

await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_code  TEXT NOT NULL UNIQUE,
  book_name  TEXT,
  author     TEXT,
  category   TEXT,
  status     TEXT NOT NULL DEFAULT 'available'
);

CREATE TABLE IF NOT EXISTS borrow_records (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  book_id            INTEGER NOT NULL REFERENCES books(id),
  borrow_date        TEXT NOT NULL,
  due_date           TEXT NOT NULL,
  actual_return_date TEXT,
  status             TEXT NOT NULL DEFAULT 'borrowing',
  confirmed_by       TEXT,
  confirmed_at       TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  borrow_record_id  INTEGER REFERENCES borrow_records(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  rule_key          TEXT NOT NULL,
  run_date          TEXT NOT NULL,
  recipient         TEXT NOT NULL,
  subject           TEXT,
  body              TEXT NOT NULL,
  sent_at           TEXT,
  status            TEXT NOT NULL,
  error_message     TEXT,
  UNIQUE (borrow_record_id, type, rule_key, run_date)
);

CREATE INDEX IF NOT EXISTS idx_borrow_status ON borrow_records(status, due_date);
CREATE INDEX IF NOT EXISTS idx_notif_status  ON notifications(status);
`);

// Nang cap co so du lieu cu (neu co) len co cot tai khoan cho nguoi muon.
try { await run("ALTER TABLE users ADD COLUMN password_hash TEXT"); } catch (e) { /* da co cot */ }
try { await run("ALTER TABLE users ADD COLUMN password_salt TEXT"); } catch (e) { /* da co cot */ }

/* ---------- Tai khoan nguoi muon (hoc sinh tu dang ky) ---------- */
export async function findAccountByIdentifier(identifier) {
  const v = String(identifier || "").trim();
  return one(
    "SELECT * FROM users WHERE (phone = ? OR email = ?) AND password_hash IS NOT NULL",
    [v, v.toLowerCase()]
  );
}

export async function findUserByContact(phone, email) {
  return one("SELECT * FROM users WHERE phone = ? AND email = ?", [phone, email]);
}

export async function createAccount({ name, phone, email, hash, salt }) {
  const existing = await findUserByContact(phone, email);
  if (existing) {
    if (existing.password_hash) {
      const err = new Error("Số điện thoại hoặc Gmail này đã có tài khoản. Hãy đăng nhập.");
      err.code = "ACCOUNT_EXISTS";
      throw err;
    }
    await run("UPDATE users SET name=?, password_hash=?, password_salt=? WHERE id=?",
      [name, hash, salt, existing.id]);
    return Number(existing.id);
  }
  const res = await run(
    "INSERT INTO users (name, phone, email, created_at, password_hash, password_salt) VALUES (?,?,?,?,?,?)",
    [name, phone, email, new Date().toISOString(), hash, salt]
  );
  return Number(res.lastInsertRowid);
}

export async function getUserById(id) {
  return one("SELECT id, name, phone, email, created_at FROM users WHERE id = ?", [id]);
}

/* ---------- Nguoi muon (admin ghi ho) ---------- */
export async function upsertUser({ name, phone, email }) {
  const found = await one("SELECT id FROM users WHERE phone = ? AND email = ?", [phone, email]);
  if (found) {
    await run("UPDATE users SET name = ? WHERE id = ?", [name, found.id]);
    return Number(found.id);
  }
  const res = await run("INSERT INTO users (name, phone, email, created_at) VALUES (?,?,?,?)",
    [name, phone, email, new Date().toISOString()]);
  return Number(res.lastInsertRowid);
}

/* ---------- Kho sach ---------- */
export async function upsertBook({ book_code, book_name, author, category }) {
  const code = String(book_code).trim().toUpperCase();
  const found = await one("SELECT id FROM books WHERE book_code = ?", [code]);
  if (found) {
    await run(
      "UPDATE books SET book_name = COALESCE(NULLIF(?,''), book_name), author = COALESCE(NULLIF(?,''), author), category = COALESCE(NULLIF(?,''), category) WHERE id = ?",
      [book_name || "", author || "", category || "", found.id]
    );
    return Number(found.id);
  }
  const res = await run(
    "INSERT INTO books (book_code, book_name, author, category, status) VALUES (?,?,?,?, 'available')",
    [code, book_name || "", author || "", category || ""]
  );
  return Number(res.lastInsertRowid);
}

export async function setBookStatus(bookId, status) {
  await run("UPDATE books SET status = ? WHERE id = ?", [status, bookId]);
}

export async function isBookBorrowed(code) {
  const row = await one(`
    SELECT r.id FROM borrow_records r
    JOIN books b ON b.id = r.book_id
    WHERE UPPER(b.book_code) = UPPER(?) AND r.status = 'borrowing' LIMIT 1`, [code]);
  return !!row;
}

/* ---------- Luot muon ---------- */
export async function listBorrows() {
  return all(`
    SELECT r.*, u.name, u.phone, u.email, b.book_code, b.book_name
    FROM borrow_records r
    JOIN users u ON u.id = r.user_id
    JOIN books b ON b.id = r.book_id
    ORDER BY r.created_at DESC`);
}

export async function getBorrow(id) {
  return one(`
    SELECT r.*, u.name, u.phone, u.email, b.book_code, b.book_name
    FROM borrow_records r
    JOIN users u ON u.id = r.user_id
    JOIN books b ON b.id = r.book_id
    WHERE r.id = ?`, [id]);
}

export async function activeBorrows() {
  return all(`
    SELECT r.*, u.name, u.phone, u.email, b.book_code, b.book_name
    FROM borrow_records r
    JOIN users u ON u.id = r.user_id
    JOIN books b ON b.id = r.book_id
    WHERE r.status = 'borrowing'`);
}

export async function createBorrow(input) {
  const { name, phone, email, book_code, book_name, borrow_date, due_date } = input;
  if (await isBookBorrowed(book_code)) {
    const err = new Error(`Mã sách ${book_code} đang được người khác mượn.`);
    err.code = "BOOK_BUSY";
    throw err;
  }
  const userId = await upsertUser({ name, phone, email });
  const bookId = await upsertBook({ book_code, book_name, author: "", category: "" });
  const res = await run(`INSERT INTO borrow_records
    (user_id, book_id, borrow_date, due_date, status, created_at)
    VALUES (?,?,?,?, 'borrowing', ?)`,
    [userId, bookId, borrow_date, due_date, new Date().toISOString()]);
  await setBookStatus(bookId, "borrowed");
  return Number(res.lastInsertRowid);
}

/** Nguoi muon tu tao luot muon bang chinh tai khoan cua minh (khong tao/doi ho so nguoi khac). */
export async function createBorrowForAccount(userId, { book_code, book_name, borrow_date, due_date }) {
  if (await isBookBorrowed(book_code)) {
    const err = new Error(`Mã sách ${book_code} đang được người khác mượn.`);
    err.code = "BOOK_BUSY";
    throw err;
  }
  const bookId = await upsertBook({ book_code, book_name, author: "", category: "" });
  const res = await run(`INSERT INTO borrow_records
    (user_id, book_id, borrow_date, due_date, status, created_at)
    VALUES (?,?,?,?, 'borrowing', ?)`,
    [userId, bookId, borrow_date, due_date, new Date().toISOString()]);
  await setBookStatus(bookId, "borrowed");
  return Number(res.lastInsertRowid);
}

export async function myBorrows(userId) {
  return all(`
    SELECT r.*, u.name, u.phone, u.email, b.book_code, b.book_name
    FROM borrow_records r
    JOIN users u ON u.id = r.user_id
    JOIN books b ON b.id = r.book_id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC`, [userId]);
}

export async function markReturned(id, { actual_return_date, confirmed_by }) {
  const rec = await getBorrow(id);
  if (!rec) return null;
  await run(`UPDATE borrow_records
    SET status='returned', actual_return_date=?, confirmed_by=?, confirmed_at=?
    WHERE id = ?`, [actual_return_date, confirmed_by || "Quản trị viên", new Date().toISOString(), id]);
  await setBookStatus(rec.book_id, "available");
  return getBorrow(id);
}

/* ---------- Thong bao ---------- */
export async function queueNotification(row) {
  try {
    const res = await run(`INSERT INTO notifications
      (borrow_record_id, type, rule_key, run_date, recipient, subject, body, status)
      VALUES (?,?,?,?,?,?,?, 'pending')`,
      [row.borrow_record_id, row.type, row.rule_key, row.run_date, row.recipient, row.subject ?? null, row.body]);
    return Number(res.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return null; // da tao hom nay roi
    throw e;
  }
}

export async function pendingNotifications() {
  return all("SELECT * FROM notifications WHERE status = 'pending' ORDER BY id");
}

export async function markNotification(id, status, errorMessage) {
  await run("UPDATE notifications SET status = ?, sent_at = ?, error_message = ? WHERE id = ?",
    [status, status === "sent" ? new Date().toISOString() : null, errorMessage || null, id]);
}

export async function listNotifications() {
  return all(`
    SELECT n.*, u.name AS to_name FROM notifications n
    LEFT JOIN borrow_records r ON r.id = n.borrow_record_id
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY n.id DESC LIMIT 300`);
}
