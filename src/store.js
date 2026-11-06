/**
 * store.js — لایه‌ی ذخیره‌سازی Chop (نسخه‌ی درون‌حافظه‌ای + پایداری روی فایل)
 *
 * این نسخه از Redis استفاده نمی‌کند. داده‌ها در حافظه‌ی پروسه نگه داشته
 * می‌شوند و هر چند ثانیه روی یک فایل JSON ذخیره می‌شوند تا بعد از ریستارت
 * پروسه (یا دیپلوی مجدد روی Railway با volume mount) دیتا از بین نرود.
 *
 * متدها و امضاهای این کلاس عمداً با نسخه‌ی قبلی (Redis) یکسان هستند تا
 * index.js، bot.js و wsrelay.js بدون هیچ تغییری کار کنند.
 *
 * برای پایداری داده‌ها روی Railway:
 *   - یک Volume Mount به مسیر `/data` بسازید و `DATA_FILE=/data/chop-data.json` ست کنید.
 *   - اگر `DATA_FILE` ست نشود، از `chop-data.json` در پوشه‌ی جاری استفاده می‌کند
 *     (روی Railway بدون volume، این فایل با هر ریستارت ریست می‌شود).
 */
import fs from "node:fs";
import path from "node:path";
import { getSiteInfo, extractRootDomain } from "./siteinfo.js";

const LOG_MAX_ALL = 1000;
const ONLINE_TTL_SECONDS = 120;
const ONLINE_ACTIVE_WINDOW = 90;
const CONFIG_CACHE_MS = 5000;
const PERSIST_PATH =
  process.env.DATA_FILE ||
  path.join(process.cwd(), "chop-data.json");
const PERSIST_INTERVAL_MS = 4000; // هر ۴ ثانیه اگر dirty باشد flush می‌کنیم
const PERSIST_DEBOUNCE_MS = 1500; // حداقل فاصله‌ی بین دو flush

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// شبیه‌سازی auto-pipelining برای حفظ همان اینترفیس Promise-based
const tick = () => new Promise((r) => setTimeout(r, 0));

export class ChopStore {
  constructor() {
    this._cfgCache = new Map();
    this._dirty = false;
    this._lastFlush = 0;
    this._flushTimer = null;
    this._data = {
      configs: {},        // id -> config object
      usage: {},          // id -> bytes (number)
      uuidx: {},          // uuid -> id
      traffic: {},        // bucket (string) -> bytes (number)
      online: {},         // "configId:ip" -> timestamp (seconds)
      logall: [],         // array of log entries (newest first)
      bot_settings: { token: "", enabled: false, secret: "" },
      bot_admins: {},     // tgId -> admin object
      bot_members: {},    // tgId -> member object
      bot_pending: {},    // tgId -> pending object
      settings: {},       // generic key -> string value
      reqcount: {},       // "YYYY-MM-DD" -> number
      // ── قابلیت‌های نظارتی ────────────────────────────────────────────
      alerts: [],         // array of alert objects (newest first)
      read_alerts: {},    // alertId -> true (برای تمایز خوانده‌شده/نشده)
      daily_usage: {},    // configId -> { "YYYY-MM-DD": bytes }
    };
    // جلسات فعال فقط در حافظه نگه داشته میشن (از فایل ریستور نمی‌شن)
    this._activeSessions = new Map();
    this._load();
    // تایمر دوره‌ای flush
    try {
      setInterval(() => this._maybeFlush(), PERSIST_INTERVAL_MS).unref();
    } catch { /* در محیط‌هایی بدون setInterval این خط نادیده گرفته می‌شود */ }
    // موقع خاموش‌شدن پروسه، فایل رو sync بنویس تا دیتا از دست نره
    for (const sig of ["SIGTERM", "SIGINT", "beforeExit"]) {
      try {
        process.on(sig, () => {
          this._flushSync();
          if (sig === "SIGINT") process.exit(0);
        });
      } catch { /* ignore */ }
    }
  }

  // ─── persistence ──────────────────────────────────────────────────
  _load() {
    try {
      if (!fs.existsSync(PERSIST_PATH)) return;
      const raw = fs.readFileSync(PERSIST_PATH, "utf8");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // merge با پیش‌فرض‌ها (تا فایل‌های قدیمی که فیلد کم دارن هم کار کنن)
      Object.assign(this._data, {
        configs: parsed.configs || {},
        usage: parsed.usage || {},
        uuidx: parsed.uuidx || {},
        traffic: parsed.traffic || {},
        online: {}, // online حالت زنده‌ست، از فایل ریستور نمی‌شه
        logall: Array.isArray(parsed.logall) ? parsed.logall : [],
        bot_settings: { token: "", enabled: false, secret: "", ...(parsed.bot_settings || {}) },
        bot_admins: parsed.bot_admins || {},
        bot_members: parsed.bot_members || {},
        bot_pending: parsed.bot_pending || {},
        settings: parsed.settings || {},
        reqcount: parsed.reqcount || {},
        // قابلیت‌های نظارتی
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
        read_alerts: parsed.read_alerts || {},
        daily_usage: parsed.daily_usage || {},
      });
      // پاک‌سازی lazy ورودی‌های قدیمی traffic (بیشتر از ۷۲ ساعت)
      const cutoff = Math.floor(Date.now() / 1000) - 72 * 3600;
      for (const bucket of Object.keys(this._data.traffic)) {
        if (Number(bucket) < cutoff) delete this._data.traffic[bucket];
      }
      // trim logall
      if (this._data.logall.length > LOG_MAX_ALL) {
        this._data.logall = this._data.logall.slice(0, LOG_MAX_ALL);
      }
    } catch (e) {
      console.error("store: load failed:", e && e.message);
    }
  }

  _markDirty() {
    this._dirty = true;
    // schedule flush زودتر از تایمر دوره‌ای
    if (this._flushTimer) return;
    const t = setTimeout(() => {
      this._flushTimer = null;
      this._maybeFlush();
    }, PERSIST_DEBOUNCE_MS);
    // unref تا تایمر، پروسه رو زنده نگه نداره (در حالت idle)
    if (typeof t.unref === "function") t.unref();
    this._flushTimer = t;
  }

  _maybeFlush() {
    if (!this._dirty) return;
    const now = Date.now();
    if (now - this._lastFlush < PERSIST_DEBOUNCE_MS) return;
    this._flushSync();
  }

  _flushSync() {
    if (!this._dirty) return;
    try {
      // مطمئن شو دایرکتوریِ مسیر فایل وجود داره (برای Volume Mount های تازه)
      const dir = path.dirname(PERSIST_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = PERSIST_PATH + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(this._data), "utf8");
      fs.renameSync(tmpPath, PERSIST_PATH); // atomic
      this._dirty = false;
      this._lastFlush = Date.now();
    } catch (e) {
      console.error("store: flush failed:", e && e.message);
    }
  }

  // ---------------------------------------------------------------- configs
  async listConfigs() {
    await tick();
    const all = Object.values(this._data.configs);
    const out = all.map((cfg) => ({ ...cfg, used_bytes: this._data.usage[cfg.id] || 0 }));
    out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return out;
  }

  async getConfig(id) {
    await tick();
    const raw = this._data.configs[id];
    if (!raw) return null;
    return { ...raw, used_bytes: this._data.usage[id] || 0 };
  }

  async getConfigByUuid(uuid) {
    await tick();
    const cached = this._cfgCache.get(uuid);
    if (cached && Date.now() - cached.ts < CONFIG_CACHE_MS) return cached.value;
    let id = this._data.uuidx[uuid];
    if (!id) {
      // fallback + self-heal
      for (const [cid, cfg] of Object.entries(this._data.configs)) {
        if (cfg.uuid === uuid) {
          id = cid;
          this._data.uuidx[uuid] = cid;
          this._markDirty();
          break;
        }
      }
    }
    if (!id) {
      this._cfgCache.set(uuid, { value: null, ts: Date.now() });
      return null;
    }
    const cfg = await this.getConfig(id);
    if (cfg && cfg.uuid === uuid) {
      this._cfgCache.set(uuid, { value: cfg, ts: Date.now() });
      return cfg;
    }
    this._cfgCache.set(uuid, { value: null, ts: Date.now() });
    return null;
  }

  async saveConfig(config) {
    await tick();
    this._data.configs[config.id] = { ...config };
    delete this._data.configs[config.id].used_bytes; // فیلد مشتق
    if (config.uuid) {
      this._data.uuidx[config.uuid] = config.id;
    }
    if (config.uuid) this._cfgCache.delete(config.uuid);
    this._markDirty();
    return true;
  }

  async deleteConfig(id) {
    await tick();
    const existing = this._data.configs[id];
    delete this._data.configs[id];
    delete this._data.usage[id];
    delete this._data.uuidx[existing?.uuid || ""];
    if (existing?.uuid) this._cfgCache.delete(existing.uuid);
    // پاک‌کردن ورودی‌های online مربوط به همین configId
    const prefix = `${id}:`;
    for (const key of Object.keys(this._data.online)) {
      if (key.startsWith(prefix)) delete this._data.online[key];
    }
    this._markDirty();
    return true;
  }

  async resetUsage(id) {
    await tick();
    delete this._data.usage[id];
    this._markDirty();
    return true;
  }

  async getUsage(id) {
    await tick();
    return this._data.usage[id] || 0;
  }

  async bumpUsage(id, amount) {
    await tick();
    this._data.usage[id] = (this._data.usage[id] || 0) + amount;
    this._markDirty();
    return this._data.usage[id];
  }

  // ---------------------------------------------------------------- traffic
  async recordTrafficBucket(nbytes) {
    await tick();
    const bucket = Math.floor(Date.now() / 1000 / 3600) * 3600;
    this._data.traffic[String(bucket)] = (this._data.traffic[String(bucket)] || 0) + nbytes;
    // پاک‌سازی ورودی‌های قدیمی‌تر از ۷۲ ساعت
    const cutoff = Math.floor(Date.now() / 1000) - 72 * 3600;
    for (const b of Object.keys(this._data.traffic)) {
      if (Number(b) < cutoff) delete this._data.traffic[b];
    }
    this._markDirty();
    return true;
  }

  async getTrafficSeries(hours = 24) {
    await tick();
    const nowSec = Math.floor(Date.now() / 1000);
    const nowBucket = Math.floor(nowSec / 3600) * 3600;
    const buckets = [];
    for (let i = hours - 1; i >= 0; i--) buckets.push(String(nowBucket - i * 3600));
    return buckets.map((bucket) => ({ hour: Number(bucket), bytes: this._data.traffic[bucket] || 0 }));
  }

  // ------------------------------------------------------------------ online
  async markOnline(configId, clientIp) {
    await tick();
    this._data.online[`${configId}:${clientIp}`] = Date.now() / 1000;
    // پاک‌سازی ورودی‌های قدیمی (هر بار که مارک می‌کنیم، یک‌بار housekeeping)
    const cutoff = Date.now() / 1000 - ONLINE_TTL_SECONDS;
    for (const [key, ts] of Object.entries(this._data.online)) {
      if (ts < cutoff) delete this._data.online[key];
    }
    return true;
  }

  async markOffline(configId, clientIp) {
    await tick();
    delete this._data.online[`${configId}:${clientIp}`];
    return true;
  }

  async _activeOnlineMembers(configId) {
    await tick();
    const now = Date.now() / 1000;
    const cutoff = now - ONLINE_TTL_SECONDS;
    const activeWindow = now - ONLINE_ACTIVE_WINDOW;
    const prefix = `${configId}:`;
    const out = [];
    for (const [key, ts] of Object.entries(this._data.online)) {
      if (ts < cutoff) { delete this._data.online[key]; continue; }
      if (ts < activeWindow) continue;
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
  }

  async onlineIpCount(configId) {
    const ips = await this._activeOnlineMembers(configId);
    return new Set(ips).size;
  }

  async onlineIpCountsForAll() {
    await tick();
    const now = Date.now() / 1000;
    const cutoff = now - ONLINE_TTL_SECONDS;
    const activeWindow = now - ONLINE_ACTIVE_WINDOW;
    const counts = {};
    const uniq = new Set();
    for (const [key, ts] of Object.entries(this._data.online)) {
      if (ts < cutoff) { delete this._data.online[key]; continue; }
      if (ts < activeWindow) continue;
      if (uniq.has(key)) continue;
      uniq.add(key);
      const sep = key.indexOf(":");
      if (sep === -1) continue;
      const cid = key.slice(0, sep);
      counts[cid] = (counts[cid] || 0) + 1;
    }
    return counts;
  }

  async isIpWithinLimit(config, clientIp) {
    const limit = config.ip_limit || 0;
    if (!limit) return true;
    const ips = await this._activeOnlineMembers(config.id);
    const set = new Set(ips);
    return set.has(clientIp) || set.size < limit;
  }

  // -------------------------------------------------------------------- logs
  // logConnection امضای قبلی رو حفظ می‌کنه (backward compatible) ولی opts
  // اضافه‌شده اجازه میده started_at، duration و status رو هم ثبت کنیم.
  async logConnection(configId, configName, clientIp, address, port, nbytes, opts = {}) {
    await tick();
    const now = Date.now() / 1000;
    // ── شناسایی و دسته‌بندی خودکار سایت ──────────────────────────────────
    const siteInfo = getSiteInfo(address);
    const entry = {
      config_id: configId,
      config_name: configName,
      ip: clientIp,
      address,
      port,
      bytes: nbytes,
      ts: now,
      // فیلدهای نظارتی جدید (اختیاری)
      started_at: opts.startedAt || now,
      duration_sec: opts.durationSec || 0,
      status: opts.status || "completed",
      // فیلدهای دسته‌بندی سایت
      domain: siteInfo.root,
      category: siteInfo.category,
      app: siteInfo.app,
      site_name: siteInfo.name,
    };
    this._data.logall.unshift(entry);
    if (this._data.logall.length > LOG_MAX_ALL) {
      this._data.logall.length = LOG_MAX_ALL;
    }
    this._markDirty();
    return true;
  }

  async getLogs(configId, limit = 100) {
    await tick();
    if (!configId) {
      return this._data.logall.slice(0, limit);
    }
    const out = [];
    for (const entry of this._data.logall) {
      if (entry.config_id === configId) {
        out.push(entry);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  // --------------------------------------------------------------- bot config
  async getBotSettings() {
    await tick();
    return {
      token: this._data.bot_settings.token || "",
      enabled: !!this._data.bot_settings.enabled,
      secret: this._data.bot_settings.secret || "",
    };
  }

  async saveBotSettings(token, enabled, secret) {
    await tick();
    this._data.bot_settings = {
      token: token || "",
      enabled: !!enabled,
      secret: secret || "",
    };
    this._markDirty();
    return true;
  }

  async listBotAdmins() {
    await tick();
    const admins = Object.values(this._data.bot_admins);
    admins.sort((a, b) => (a.added_at || 0) - (b.added_at || 0));
    return admins;
  }

  async isBotAdmin(tgId) {
    await tick();
    return !!this._data.bot_admins[String(tgId)];
  }

  async addBotAdmin(tgId, addedBy = "") {
    await tick();
    this._data.bot_admins[String(tgId)] = {
      id: String(tgId),
      added_at: Date.now() / 1000,
      added_by: addedBy,
    };
    this._markDirty();
    return true;
  }

  async removeBotAdmin(tgId) {
    await tick();
    delete this._data.bot_admins[String(tgId)];
    this._markDirty();
    return true;
  }

  async upsertBotMember(tgId, username, firstName) {
    await tick();
    const key = String(tgId);
    const now = Date.now() / 1000;
    const existing = this._data.bot_members[key];
    this._data.bot_members[key] = existing
      ? { ...existing, username, first_name: firstName, last_seen: now }
      : { id: key, username, first_name: firstName, joined_at: now, last_seen: now };
    this._markDirty();
    return true;
  }

  async listBotMembers() {
    await tick();
    const members = Object.values(this._data.bot_members);
    members.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    return members;
  }

  async removeBotMember(tgId) {
    await tick();
    delete this._data.bot_members[String(tgId)];
    this._markDirty();
    return true;
  }

  async setBotPending(tgId, data) {
    await tick();
    this._data.bot_pending[String(tgId)] = data;
    this._markDirty();
    return true;
  }

  async getBotPending(tgId) {
    await tick();
    return this._data.bot_pending[String(tgId)] || null;
  }

  async clearBotPending(tgId) {
    await tick();
    delete this._data.bot_pending[String(tgId)];
    this._markDirty();
    return true;
  }

  // ------------------------------------------------------------------ settings (generic key/value)
  async getSetting(key) {
    await tick();
    const v = this._data.settings[key];
    return v === undefined || v === null ? null : v;
  }

  async setSetting(key, value) {
    await tick();
    this._data.settings[key] = String(value);
    this._markDirty();
    return true;
  }

  // ------------------------------------------------------------ request counter
  _utcDay() {
    return new Date().toISOString().slice(0, 10);
  }

  async bumpRequestCounter() {
    await tick();
    const day = this._utcDay();
    this._data.reqcount[day] = (this._data.reqcount[day] || 0) + 1;
    // پاک‌سازی روزهای قدیمی‌تر از ۳ روز
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(this._data.reqcount)) {
      if (d < cutoff) delete this._data.reqcount[d];
    }
    this._markDirty();
    return this._data.reqcount[day];
  }

  async getRequestCounter() {
    await tick();
    return this._data.reqcount[this._utcDay()] || 0;
  }

  async getRequestCounterHistory(days = 7) {
    await tick();
    const now = new Date();
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day: d, count: this._data.reqcount[d] || 0 });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────
  //  قابلیت‌های نظارتی (Monitoring / Supervision)
  // ───────────────────────────────────────────────────────────────────

  // ---- Active Sessions (در حافظه، از فایل ریستور نمی‌شه) ----
  async addActiveSession(session) {
    await tick();
    const id = session.id || newId();
    const entry = {
      id,
      config_id: session.config_id,
      config_name: session.config_name,
      ip: session.ip,
      address: session.address,
      port: session.port,
      started_at: session.started_at || Date.now() / 1000,
      bytes_up: 0,
      bytes_down: 0,
      bytes_total: 0,
    };
    this._activeSessions.set(id, entry);
    return id;
  }

  async updateActiveSession(id, updates) {
    await tick();
    const s = this._activeSessions.get(id);
    if (!s) return false;
    Object.assign(s, updates);
    s.bytes_total = (s.bytes_up || 0) + (s.bytes_down || 0);
    return true;
  }

  async removeActiveSession(id) {
    await tick();
    const s = this._activeSessions.get(id);
    if (!s) return null;
    this._activeSessions.delete(id);
    return s;
  }

  async getActiveSessions() {
    await tick();
    const now = Date.now() / 1000;
    return [...this._activeSessions.values()].map(s => ({
      ...s,
      duration_sec: Math.max(0, Math.floor(now - s.started_at)),
    }));
  }

  // ---- Top Destinations (مقاصد پراستفاده) ----
  // از logall تجمیع می‌کنه — برای هر آدرس (دامنه/IP) مجموع bytes و تعداد اتصال.
  async getTopDestinations(configId, limit = 20, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const map = new Map();
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      if (!entry.address) continue;
      const cur = map.get(entry.address) || { address: entry.address, count: 0, bytes: 0 };
      cur.count++;
      cur.bytes += entry.bytes || 0;
      map.set(entry.address, cur);
    }
    const out = [...map.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
    return out;
  }

  // ---- Activity Heatmap (نقشه‌ی فعالیت ساعتی) ----
  // برای هر ساعت از ۰ تا ۲۳، مجموع bytes و تعداد اتصال‌ها رو برمی‌گردونه.
  async getActivityHeatmap(configId, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, bytes: 0 }));
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      // ساعت‌روز رو بر اساس timestamp استخراج می‌کنیم
      const hour = new Date(entry.ts * 1000).getHours();
      hours[hour].count++;
      hours[hour].bytes += entry.bytes || 0;
    }
    return hours;
  }

  // ---- Site Visits (بازدید سایت‌ها) ----
  // لاگ زمان‌بندی‌شده‌ی سایت‌های باز‌شده — مثل getLogs ولی با نمایش نام سایت و دسته
  async getSiteVisits(configId, limit = 100, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const out = [];
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      if (!entry.address) continue;
      out.push({
        ts: entry.ts,
        started_at: entry.started_at || entry.ts,
        duration_sec: entry.duration_sec || 0,
        config_id: entry.config_id,
        config_name: entry.config_name,
        address: entry.address,
        domain: entry.domain || extractRootDomain(entry.address),
        site_name: entry.site_name || entry.domain || entry.address,
        category: entry.category || 'other',
        app: entry.app || null,
        bytes: entry.bytes || 0,
        ip: entry.ip,
        status: entry.status || 'completed',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- Site Stats (آمار هر سایت) ----
  // برای هر دامنه: تعداد بازدید، مجموع حجم، مجموع مدت، اولین/آخرین بازدید
  async getSiteStats(configId, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const map = new Map();
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      if (!entry.address) continue;
      const domain = entry.domain || extractRootDomain(entry.address);
      const cur = map.get(domain) || {
        domain,
        site_name: entry.site_name || domain,
        category: entry.category || 'other',
        app: entry.app || null,
        visits: 0,
        bytes: 0,
        duration_sec: 0,
        first_seen: entry.ts,
        last_seen: entry.ts,
      };
      cur.visits++;
      cur.bytes += entry.bytes || 0;
      cur.duration_sec += entry.duration_sec || 0;
      cur.first_seen = Math.min(cur.first_seen, entry.ts);
      cur.last_seen = Math.max(cur.last_seen, entry.ts);
      map.set(domain, cur);
    }
    return [...map.values()].sort((a, b) => b.bytes - a.bytes);
  }

  // ---- Category Stats (آمار دسته‌بندی) ----
  // برای هر دسته: تعداد بازدید، مجموع حجم، تعداد سایت‌های منحصربه‌فرد
  async getCategoryStats(configId, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const map = new Map();
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      if (!entry.address) continue;
      const cat = entry.category || 'other';
      const cur = map.get(cat) || { category: cat, visits: 0, bytes: 0, sites: new Set() };
      cur.visits++;
      cur.bytes += entry.bytes || 0;
      cur.sites.add(entry.domain || extractRootDomain(entry.address));
      map.set(cat, cur);
    }
    return [...map.entries()].map(([cat, v]) => ({
      category: cat,
      visits: v.visits,
      bytes: v.bytes,
      site_count: v.sites.size,
    })).sort((a, b) => b.bytes - a.bytes);
  }

  // ---- Detected Apps (اپ‌های شناسایی‌شده) ----
  async getDetectedApps(configId, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const map = new Map();
    for (const entry of this._data.logall) {
      if (entry.ts < cutoff) continue;
      if (configId && entry.config_id !== configId) continue;
      if (!entry.app) continue;
      const cur = map.get(entry.app) || {
        app: entry.app,
        visits: 0,
        bytes: 0,
        last_seen: entry.ts,
        categories: new Set(),
      };
      cur.visits++;
      cur.bytes += entry.bytes || 0;
      cur.last_seen = Math.max(cur.last_seen, entry.ts);
      cur.categories.add(entry.category);
      map.set(entry.app, cur);
    }
    return [...map.values()].map(v => ({
      app: v.app,
      visits: v.visits,
      bytes: v.bytes,
      last_seen: v.last_seen,
      categories: [...v.categories],
    })).sort((a, b) => b.bytes - a.bytes);
  }

  // ---- First-Time Visits (سایت‌های جدید) ----
  // دامنه‌هایی که در N روز اخیر برای اولین‌بار دیده شدن
  async getFirstTimeVisits(configId, days = 7) {
    await tick();
    const cutoff = Date.now() / 1000 - days * 86400;
    const recentSeen = new Set();
    const olderSeen = new Set();
    for (const entry of this._data.logall) {
      if (!entry.address) continue;
      if (configId && entry.config_id !== configId) continue;
      const domain = entry.domain || extractRootDomain(entry.address);
      if (entry.ts >= cutoff) recentSeen.add(domain);
      else olderSeen.add(domain);
    }
    // دامنه‌هایی که در بازه‌ی اخیر دیده شدن ولی قبلاً نبودن
    return [...recentSeen].filter(d => !olderSeen.has(d)).map(d => {
      const si = getSiteInfo(d);
      return { domain: d, site_name: si.name, category: si.category, app: si.app };
    });
  }

  // ---- Daily Usage (مصرف روزانه) ----
  async getDailyUsageHistory(configId, days = 30) {
    await tick();
    const now = new Date();
    const out = [];
    const usage = this._data.daily_usage[configId] || {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const dayKey = d.toISOString().slice(0, 10);
      out.push({ day: dayKey, bytes: usage[dayKey] || 0 });
    }
    return out;
  }

  async bumpDailyUsage(configId, bytes) {
    await tick();
    const day = this._utcDay();
    if (!this._data.daily_usage[configId]) this._data.daily_usage[configId] = {};
    this._data.daily_usage[configId][day] = (this._data.daily_usage[configId][day] || 0) + bytes;
    // پاک‌سازی روزهای قدیمی‌تر از ۳۰ روز
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const cid of Object.keys(this._data.daily_usage)) {
      for (const d of Object.keys(this._data.daily_usage[cid])) {
        if (d < cutoff) delete this._data.daily_usage[cid][d];
      }
    }
    this._markDirty();
    return this._data.daily_usage[configId][day];
  }

  async getDailyUsageStatus(configId) {
    await tick();
    const day = this._utcDay();
    const cfg = this._data.configs[configId];
    const limit = cfg?.daily_quota_bytes || 0;
    const used = (this._data.daily_usage[configId] && this._data.daily_usage[configId][day]) || 0;
    return { today_bytes: used, limit_bytes: limit, day };
  }

  // ---- Alerts (هشدارها) ----
  async addAlert(type, configId, configName, message, severity = "info", extra = {}) {
    await tick();
    const id = newId();
    const alert = {
      id,
      type,           // 'quota_exceeded' | 'curfew_blocked' | 'blocked_destination' | 'unusual_hour' | 'ip_limit' | 'new_ip'
      config_id: configId,
      config_name: configName,
      message,
      severity,       // 'info' | 'warn' | 'danger'
      extra,
      ts: Date.now() / 1000,
      read: false,
    };
    this._data.alerts.unshift(alert);
    // محدود نگه‌داشتن لیست هشدارها به ۲۰۰ مورد آخر
    if (this._data.alerts.length > 200) {
      this._data.alerts.length = 200;
    }
    this._markDirty();
    return alert;
  }

  async getAlerts(limit = 50, onlyUnread = false) {
    await tick();
    let out = this._data.alerts;
    if (onlyUnread) out = out.filter(a => !a.read);
    return out.slice(0, limit);
  }

  async markAlertRead(id) {
    await tick();
    const alert = this._data.alerts.find(a => a.id === id);
    if (alert) { alert.read = true; this._markDirty(); }
    return true;
  }

  async markAllAlertsRead() {
    await tick();
    for (const a of this._data.alerts) a.read = true;
    this._markDirty();
    return true;
  }

  async getUnreadAlertsCount() {
    await tick();
    return this._data.alerts.filter(a => !a.read).length;
  }

  // ---- Notes & Curfew (یادداشت و ساعت‌های مجاز) ----
  // این‌ها داخل خود config object ذخیره می‌شن، پس متدهای جدا لازم نیست —
  // اما برای راحتی، helper های زیر رو اضافه می‌کنیم.
  async setNotes(configId, notes) {
    await tick();
    const cfg = this._data.configs[configId];
    if (!cfg) return false;
    cfg.notes = String(notes || "");
    this._markDirty();
    return true;
  }

  async setCurfew(configId, curfew) {
    await tick();
    const cfg = this._data.configs[configId];
    if (!cfg) return false;
    // curfew: { enabled: bool, start_hour: 0-23, end_hour: 0-23, days: [0,1,2,3,4,5,6] }
    cfg.curfew = {
      enabled: !!curfew.enabled,
      start_hour: Math.max(0, Math.min(23, parseInt(curfew.start_hour, 10) || 0)),
      end_hour: Math.max(0, Math.min(23, parseInt(curfew.end_hour, 10) || 0)),
      days: Array.isArray(curfew.days) ? curfew.days.slice(0, 7).map(d => Math.max(0, Math.min(6, parseInt(d, 10))) | 0) : [0,1,2,3,4,5,6],
    };
    this._markDirty();
    return true;
  }

  // چک می‌کنه که آیا در حال حاضر برای این کانفیگ ساعتِ مجاز هست.
  async isCurfewActive(configId) {
    await tick();
    const cfg = this._data.configs[configId];
    if (!cfg || !cfg.curfew || !cfg.curfew.enabled) return false;
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0=Sunday
    const c = cfg.curfew;
    if (c.days && c.days.length && !c.days.includes(day)) return false;
    const start = c.start_hour;
    const end = c.end_hour;
    if (start === end) return false; // same hour = no curfew
    if (start < end) {
      // مثلاً start=11, end=14 → ساعت ۱۱ تا ۱۴ مسدود
      return hour >= start && hour < end;
    } else {
      // مثلاً start=23, end=7 → ساعت ۲۳ تا ۷ صبح مسدود (نگهبان شبانه)
      return hour >= start || hour < end;
    }
  }

  // ------------------------------------------------------------------ misc
  async newId() {
    return newId();
  }

  async healthBackend() {
    return "in-memory (file-persisted)";
  }

  // --------------------------------------------------------- backup/restore
  async exportAll() {
    await tick();
    return {
      version: 2,
      app: "chop",
      exported_at: Date.now() / 1000,
      configs: { ...this._data.configs },
      usage: { ...this._data.usage },
      traffic_hourly: { ...this._data.traffic },
      bot_settings: await this.getBotSettings(),
      bot_admins: { ...this._data.bot_admins },
      bot_members: { ...this._data.bot_members },
      logs_all: this._data.logall.slice(),
      // قابلیت‌های نظارتی
      alerts: this._data.alerts.slice(),
      daily_usage: JSON.parse(JSON.stringify(this._data.daily_usage)),
    };
  }

  async importAll(data, mode = "replace") {
    await tick();
    if (!data || typeof data !== "object" || !("configs" in data)) {
      throw new Error("فایل بکاپ معتبر نیست");
    }

    if (mode === "replace") {
      this._data.configs = {};
      this._data.usage = {};
      this._data.uuidx = {};
      this._data.traffic = {};
      this._data.bot_admins = {};
      this._data.bot_members = {};
      this._data.bot_pending = {};
      this._data.logall = [];
      this._data.online = {};
      this._data.alerts = [];
      this._data.read_alerts = {};
      this._data.daily_usage = {};
      this._cfgCache.clear();
    }

    const counters = { configs: 0, admins: 0, members: 0 };

    for (const [configId, cfg] of Object.entries(data.configs || {})) {
      this._data.configs[configId] = { ...cfg };
      if (cfg && cfg.uuid) this._data.uuidx[cfg.uuid] = configId;
      counters.configs++;
    }
    for (const [configId, used] of Object.entries(data.usage || {})) {
      this._data.usage[configId] = Number(used) || 0;
    }
    for (const [bucket, val] of Object.entries(data.traffic_hourly || {})) {
      this._data.traffic[bucket] = Number(val) || 0;
    }

    const botSettings = data.bot_settings || {};
    if (botSettings.token || botSettings.enabled !== undefined) {
      await this.saveBotSettings(botSettings.token || "", !!botSettings.enabled, botSettings.secret || "");
    }

    for (const [tgId, admin] of Object.entries(data.bot_admins || {})) {
      this._data.bot_admins[tgId] = { ...admin };
      counters.admins++;
    }
    for (const [tgId, member] of Object.entries(data.bot_members || {})) {
      this._data.bot_members[tgId] = { ...member };
      counters.members++;
    }

    const allLogEntries = [...(data.logs_all || [])];
    for (const entries of Object.values(data.logs_per_config || {})) {
      if (Array.isArray(entries)) allLogEntries.push(...entries);
    }
    if (allLogEntries.length) {
      this._data.logall = allLogEntries.slice(0, LOG_MAX_ALL);
    }

    // قابلیت‌های نظارتی: alerts و daily_usage
    if (Array.isArray(data.alerts)) {
      this._data.alerts = data.alerts.slice(0, 200);
    }
    if (data.daily_usage && typeof data.daily_usage === "object") {
      this._data.daily_usage = JSON.parse(JSON.stringify(data.daily_usage));
    }

    this._markDirty();
    return counters;
  }
}

/** singleton سراسری، درست مثل getStore(env) نسخه‌ی قبلی */
let _store = null;
export function getStore() {
  if (!_store) _store = new ChopStore();
  return _store;
}
