/**
 * siteinfo.js — شناسایی و دسته‌بندی خودکار سایت‌ها و اپ‌ها
 *
 * وقتی یک اتصال VLESS برقرار می‌شه، آدرس مقصد (دامنه یا IP) در هدر VLESS هست.
 * این ماژول از یک پایگاه‌داده‌ی داخلی (~۱۰۰ دامنه‌ی پرکاربرد) برای:
 *   - استخراج ریشه‌ی دامنه (مثلاً cdn.instagram.com → instagram.com)
 *   - دسته‌بندی (اجتماعی، استریم، خبری، بازی، خرید، ...)
 *   - شناسایی اپ (اینستاگرام، یوتیوب، تلگرام، ...)
 *   - نام فارسی نمایشی
 * استفاده می‌کنه.
 *
 * دامنه‌هایی که در لیست نیستن به‌صورت «سایر» دسته‌بندی می‌شن ولی همچنان
 * آدرس کامل و ریشه‌ی دامنه‌شون ثبت و نمایش داده می‌شه.
 */

// نقشه‌ی دامنه → { category, app, name }
// کلیدها ریشه‌ی دامنه هستن (مثلاً instagram.com، نه cdn.instagram.com).
const SITE_DB = {
  // ─── رسانه‌های اجتماعی ───────────────────────────────────────────────
  'instagram.com':    { cat: 'social', app: 'Instagram',  fa: 'اینستاگرام' },
  'cdninstagram.com': { cat: 'social', app: 'Instagram',  fa: 'اینستاگرام (CDN)' },
  'fbcdn.net':        { cat: 'social', app: 'Facebook',   fa: 'فیسبوک/اینستاگرام (CDN)' },
  'facebook.com':     { cat: 'social', app: 'Facebook',   fa: 'فیسبوک' },
  'twitter.com':      { cat: 'social', app: 'Twitter',    fa: 'توییتر' },
  'x.com':            { cat: 'social', app: 'X',          fa: 'ایکس (توییتر)' },
  'twimg.com':        { cat: 'social', app: 'Twitter',    fa: 'توییتر (CDN)' },
  'tiktok.com':       { cat: 'social', app: 'TikTok',     fa: 'تیک‌تاک' },
  'tiktokcdn.com':    { cat: 'social', app: 'TikTok',     fa: 'تیک‌تاک (CDN)' },
  'tiktokv.com':      { cat: 'social', app: 'TikTok',     fa: 'تیک‌تاک' },
  'musical.ly':       { cat: 'social', app: 'TikTok',     fa: 'تیک‌تاک' },
  'snapchat.com':     { cat: 'social', app: 'Snapchat',   fa: 'اسنپ‌چت' },
  'pinterest.com':    { cat: 'social', app: 'Pinterest',  fa: 'پینترست' },
  'linkedin.com':     { cat: 'social', app: 'LinkedIn',   fa: 'لینکدین' },
  'reddit.com':       { cat: 'social', app: 'Reddit',     fa: 'ردیت' },
  'tumblr.com':       { cat: 'social', app: 'Tumblr',     fa: 'تامبلر' },

  // ─── پیام‌رسان ───────────────────────────────────────────────────────
  'telegram.org':     { cat: 'messaging', app: 'Telegram',  fa: 'تلگرام' },
  't.me':             { cat: 'messaging', app: 'Telegram',  fa: 'تلگرام' },
  'telegram.me':      { cat: 'messaging', app: 'Telegram',  fa: 'تلگرام' },
  'whatsapp.com':     { cat: 'messaging', app: 'WhatsApp',  fa: 'واتس‌اپ' },
  'whatsapp.net':     { cat: 'messaging', app: 'WhatsApp',  fa: 'واتس‌اپ' },
  'signal.org':       { cat: 'messaging', app: 'Signal',    fa: 'سیگنال' },
  'discord.com':      { cat: 'messaging', app: 'Discord',   fa: 'دیسکورد' },
  'discordapp.com':   { cat: 'messaging', app: 'Discord',   fa: 'دیسکورد' },
  'discordapp.net':   { cat: 'messaging', app: 'Discord',   fa: 'دیسکورد' },
  'discord.media':    { cat: 'messaging', app: 'Discord',   fa: 'دیسکورد' },
  'viber.com':        { cat: 'messaging', app: 'Viber',     fa: 'وایبر' },
  'line.me':          { cat: 'messaging', app: 'LINE',      fa: 'لاین' },
  'imo.im':           { cat: 'messaging', app: 'imo',       fa: 'ایمو' },

  // ─── استریم/ویدیو/موسیقی ────────────────────────────────────────────
  'youtube.com':      { cat: 'streaming', app: 'YouTube',      fa: 'یوتیوب' },
  'googlevideo.com':  { cat: 'streaming', app: 'YouTube',      fa: 'یوتیوب (ویدیو)' },
  'ytimg.com':        { cat: 'streaming', app: 'YouTube',      fa: 'یوتیوب (تصاویر)' },
  'youtu.be':         { cat: 'streaming', app: 'YouTube',      fa: 'یوتیوب' },
  'ytcdn.com':        { cat: 'streaming', app: 'YouTube',      fa: 'یوتیوب' },
  'netflix.com':      { cat: 'streaming', app: 'Netflix',      fa: 'نتفلیکس' },
  'nflxvideo.net':    { cat: 'streaming', app: 'Netflix',      fa: 'نتفلیکس (ویدیو)' },
  'nflximg.net':      { cat: 'streaming', app: 'Netflix',      fa: 'نتفلیکس' },
  'spotify.com':      { cat: 'streaming', app: 'Spotify',      fa: 'اسپاتیفای' },
  'scdn.co':          { cat: 'streaming', app: 'Spotify',      fa: 'اسپاتیفای (CDN)' },
  'spotifycdn.com':   { cat: 'streaming', app: 'Spotify',      fa: 'اسپاتیفای' },
  'twitch.tv':        { cat: 'streaming', app: 'Twitch',       fa: 'توئیچ' },
  'ttvnw.net':        { cat: 'streaming', app: 'Twitch',       fa: 'توئیچ (CDN)' },
  'disneyplus.com':   { cat: 'streaming', app: 'Disney+',      fa: 'دیزنی پلاس' },
  'disney-plus.net':  { cat: 'streaming', app: 'Disney+',      fa: 'دیزنی پلاس' },
  'hbomax.com':       { cat: 'streaming', app: 'HBO Max',      fa: 'اچ‌بی‌او مکس' },
  'max.com':          { cat: 'streaming', app: 'Max',          fa: 'مکس' },
  'primevideo.com':   { cat: 'streaming', app: 'Prime Video',  fa: 'پرایم ویدیو' },
  'amazonvideo.com':  { cat: 'streaming', app: 'Prime Video',  fa: 'پرایم ویدیو' },
  'soundcloud.com':   { cat: 'streaming', app: 'SoundCloud',   fa: 'ساندکلود' },
  'apple.com':        { cat: 'streaming', app: 'Apple',        fa: 'اپل' },
  'mzstatic.com':     { cat: 'streaming', app: 'Apple',        fa: 'اپل (CDN)' },
  'applemusic.com':   { cat: 'streaming', app: 'Apple Music',  fa: 'اپل موزیک' },
  'deezer.com':       { cat: 'streaming', app: 'Deezer',       fa: 'دیزر' },
  'tidal.com':        { cat: 'streaming', app: 'Tidal',        fa: 'تایدال' },
  'vimeo.com':        { cat: 'streaming', app: 'Vimeo',        fa: 'ویمیو' },
  'dailymotion.com':  { cat: 'streaming', app: 'Dailymotion',  fa: 'دیلی‌موشن' },

  // ─── استریم ایرانی ───────────────────────────────────────────────────
  'aparat.com':       { cat: 'streaming', app: 'Aparat',      fa: 'آپارات' },
  'aparatcdn.com':    { cat: 'streaming', app: 'Aparat',      fa: 'آپارات' },
  'filimo.com':       { cat: 'streaming', app: 'Filimo',      fa: 'فیلمو' },
  'namava.com':       { cat: 'streaming', app: 'Namava',      fa: 'نماوا' },
  'filmnet.ir':       { cat: 'streaming', app: 'FilmNet',     fa: 'فیلم‌نت' },

  // ─── خبری ────────────────────────────────────────────────────────────
  'bbc.com':          { cat: 'news', app: null, fa: 'بی‌بی‌سی' },
  'bbc.co.uk':        { cat: 'news', app: null, fa: 'بی‌بی‌سی' },
  'cnn.com':          { cat: 'news', app: null, fa: 'سی‌ان‌ان' },
  'reuters.com':      { cat: 'news', app: null, fa: 'رویترز' },
  'aljazeera.com':    { cat: 'news', app: null, fa: 'الجزیره' },
  'nytimes.com':      { cat: 'news', app: null, fa: 'نیویورک تایمز' },
  'washingtonpost.com':{cat: 'news', app: null, fa: 'واشنگتن پست' },
  'theguardian.com':  { cat: 'news', app: null, fa: 'گاردین' },
  'foxnews.com':      { cat: 'news', app: null, fa: 'فاکس نیوز' },
  'breitbart.com':    { cat: 'news', app: null, fa: 'برایت‌بارت' },
  'iranintl.com':     { cat: 'news', app: null, fa: 'ایران اینترنشنال' },
  'farsnews.com':     { cat: 'news', app: null, fa: 'فارس' },
  'tasnimnews.com':   { cat: 'news', app: null, fa: 'تسنیم' },
  'isna.ir':          { cat: 'news', app: null, fa: 'ایسنا' },
  'mehrnews.com':     { cat: 'news', app: null, fa: 'مهر' },

  // ─── بازی ────────────────────────────────────────────────────────────
  'steampowered.com': { cat: 'gaming', app: 'Steam',       fa: 'استیم' },
  'steamcommunity.com':{cat: 'gaming', app: 'Steam',       fa: 'استیم' },
  'steamstatic.com':  { cat: 'gaming', app: 'Steam',       fa: 'استیم' },
  'steamcdn-a.akamaihd.net':{cat:'gaming',app:'Steam',     fa: 'استیم' },
  'epicgames.com':    { cat: 'gaming', app: 'Epic Games',  fa: 'اپیک گیمز' },
  'riotgames.com':    { cat: 'gaming', app: 'Riot Games',  fa: 'رایت گیمز' },
  'blizzard.com':     { cat: 'gaming', app: 'Blizzard',    fa: 'بلیزارد' },
  'battle.net':       { cat: 'gaming', app: 'Battle.net',  fa: 'بتل‌نت' },
  'playstation.com':  { cat: 'gaming', app: 'PlayStation', fa: 'پلی‌استیشن' },
  'xbox.com':         { cat: 'gaming', app: 'Xbox',        fa: 'ایکس‌باکس' },
  'nintendo.com':     { cat: 'gaming', app: 'Nintendo',    fa: 'نینتندو' },
  'roblox.com':       { cat: 'gaming', app: 'Roblox',      fa: 'روبلوکس' },
  'miniclip.com':     { cat: 'gaming', app: null,          fa: 'مینی‌کلیپ' },

  // ─── خرید ────────────────────────────────────────────────────────────
  'amazon.com':       { cat: 'shopping', app: 'Amazon',     fa: 'آمازون' },
  'ebay.com':         { cat: 'shopping', app: 'eBay',       fa: 'ای‌بی' },
  'aliexpress.com':   { cat: 'shopping', app: 'AliExpress', fa: 'علی‌اکسپرس' },
  'alibaba.com':      { cat: 'shopping', app: 'Alibaba',    fa: 'علی‌بابا' },
  'digikala.com':     { cat: 'shopping', app: 'Digikala',   fa: 'دیجی‌کالا' },
  'digikalastatic.com':{cat: 'shopping', app: 'Digikala',   fa: 'دیجی‌کالا' },
  'basalam.com':      { cat: 'shopping', app: 'Basalam',    fa: 'باسلام' },
  'torob.com':        { cat: 'shopping', app: 'Torob',      fa: 'ترب' },
  'okala.com':        { cat: 'shopping', app: 'Okala',      fa: 'اوکالا' },
  'esam.com':         { cat: 'shopping', app: 'eSam',       fa: 'اسام' },
  'wish.com':         { cat: 'shopping', app: 'Wish',       fa: 'ویش' },
  'etsy.com':         { cat: 'shopping', app: 'Etsy',       fa: 'اتسی' },

  // ─── جستجو ───────────────────────────────────────────────────────────
  'google.com':       { cat: 'search', app: 'Google',       fa: 'گوگل' },
  'googleadservices.com':{cat:'ads', app:'Google',          fa: 'گوگل ادز' },
  'googlesyndication.com':{cat:'ads',app:'Google',          fa: 'گوگل ادز' },
  'doubleclick.net':  { cat: 'ads', app: 'Google',          fa: 'گوگل ادز' },
  'bing.com':         { cat: 'search', app: 'Bing',         fa: 'بینگ' },
  'duckduckgo.com':   { cat: 'search', app: 'DuckDuckGo',   fa: 'داک‌داک‌گو' },
  'yandex.com':       { cat: 'search', app: 'Yandex',       fa: 'یاندکس' },
  'baidu.com':        { cat: 'search', app: 'Baidu',        fa: 'بایدو' },
  'yahoo.com':        { cat: 'search', app: 'Yahoo',        fa: 'یاهو' },

  // ─── ابری/CDN ─────────────────────────────────────────────────────────
  'cloudflare.com':   { cat: 'cdn', app: null, fa: 'کلادفلر' },
  'cloudflareinsights.com':{cat:'cdn',app:null,fa: 'کلادفلر' },
  'akamai.net':       { cat: 'cdn', app: null, fa: 'اکامای' },
  'akamaized.net':    { cat: 'cdn', app: null, fa: 'اکامای' },
  'fastly.net':       { cat: 'cdn', app: null, fa: 'فستلی' },
  'amazonaws.com':    { cat: 'cdn', app: null, fa: 'AWS' },
  'googleapis.com':   { cat: 'cdn', app: 'Google', fa: 'گوگل API' },
  'gstatic.com':      { cat: 'cdn', app: 'Google', fa: 'گوگل' },
  'googleusercontent.com':{cat:'cdn',app:'Google',fa: 'گوگل' },

  // ─── برنامه‌نویسی ────────────────────────────────────────────────────
  'github.com':       { cat: 'dev', app: 'GitHub',       fa: 'گیت‌هاب' },
  'githubusercontent.com':{cat:'dev',app:'GitHub',       fa: 'گیت‌هاب' },
  'githubassets.com': { cat: 'dev', app: 'GitHub',       fa: 'گیت‌هاب' },
  'gitlab.com':       { cat: 'dev', app: 'GitLab',       fa: 'گیت‌لب' },
  'bitbucket.org':    { cat: 'dev', app: 'Bitbucket',    fa: 'بیت‌باکت' },
  'stackoverflow.com':{ cat: 'dev', app: 'Stack Overflow',fa: 'استک اورفلو' },
  'npmjs.com':        { cat: 'dev', app: 'npm',          fa: 'ان‌پی‌ام' },
  'docker.com':       { cat: 'dev', app: 'Docker',       fa: 'داکر' },

  // ─── ایمیل ───────────────────────────────────────────────────────────
  'gmail.com':        { cat: 'email', app: 'Gmail',    fa: 'جی‌میل' },
  'outlook.com':      { cat: 'email', app: 'Outlook',  fa: 'اوت‌لوک' },
  'outlook.office.com':{cat: 'email', app: 'Outlook',  fa: 'اوت‌لوک' },
  'protonmail.com':   { cat: 'email', app: 'Proton',   fa: 'پروتون' },
  'mail.yahoo.com':   { cat: 'email', app: 'Yahoo',    fa: 'یاهو میل' },

  // ─── اشتراک فایل ─────────────────────────────────────────────────────
  'dropbox.com':      { cat: 'files', app: 'Dropbox',     fa: 'دراپ‌باکس' },
  'drive.google.com': { cat: 'files', app: 'Google Drive',fa: 'گوگل درایو' },
  'mega.nz':          { cat: 'files', app: 'Mega',        fa: 'مگا' },
  'mediafire.com':    { cat: 'files', app: 'MediaFire',   fa: 'مدیا‌فایر' },
  'wetransfer.com':   { cat: 'files', app: 'WeTransfer',  fa: 'وی‌ترنسفر' },
  'onedrive.com':     { cat: 'files', app: 'OneDrive',    fa: 'وان‌درایو' },

  // ─── VPN/پروکسی ──────────────────────────────────────────────────────
  'nordvpn.com':      { cat: 'vpn', app: 'NordVPN',   fa: 'نورد وی‌پی‌ان' },
  'expressvpn.com':   { cat: 'vpn', app: 'ExpressVPN',fa: 'اکسپرس وی‌پی‌ان' },
  'surfshark.com':    { cat: 'vpn', app: 'Surfshark', fa: 'سرف‌شارک' },
  'protonvpn.com':    { cat: 'vpn', app: 'ProtonVPN', fa: 'پروتون وی‌پی‌ان' },

  // ─── سایر پرکاربرد ───────────────────────────────────────────────────
  'wikipedia.org':    { cat: 'reference', app: 'Wikipedia', fa: 'ویکی‌پدیا' },
  'wikimedia.org':    { cat: 'reference', app: 'Wikipedia', fa: 'ویکی‌پدیا' },
  'medium.com':       { cat: 'blog', app: 'Medium',       fa: 'مدیوم' },
  'wordpress.com':    { cat: 'blog', app: 'WordPress',    fa: 'وردپرس' },
  'substack.com':     { cat: 'blog', app: 'Substack',     fa: 'ساب‌استک' },
  'patreon.com':      { cat: 'other', app: 'Patreon',     fa: 'پاتریون' },
  'goFundme.com':     { cat: 'other', app: 'GoFundMe',    fa: 'گوفاندمی' },
  'change.org':       { cat: 'other', app: 'Change.org',  fa: 'چنج' },
  'imdb.com':         { cat: 'reference', app: 'IMDb',    fa: 'آی‌ام‌دی‌بی' },
  'rottentomatoes.com':{cat:'reference',app:null,         fa: 'روتن تومیتوز' },
  'metacritic.com':   { cat: 'reference', app: null,      fa: 'متاکریتیک' },
  'tripadvisor.com':  { cat: 'travel', app: 'TripAdvisor',fa: 'تریپ‌ادوایزر' },
  'booking.com':      { cat: 'travel', app: 'Booking',    fa: 'بوکینگ' },
  'airbnb.com':       { cat: 'travel', app: 'Airbnb',     fa: 'ایربن‌بی' },
  'uber.com':         { cat: 'travel', app: 'Uber',       fa: 'اوبر' },
  'lyft.com':         { cat: 'travel', app: 'Lyft',       fa: 'لیفت' },
  'snapp.ir':         { cat: 'travel', app: 'Snapp',      fa: 'اسنپ' },
  'snappfood.com':    { cat: 'food', app: 'Snapp Food',   fa: 'اسنپ‌فود' },
};

// دسته‌بندی فارسی + رنگ برای نمایش
export const CATEGORY_INFO = {
  social:    { fa: 'رسانه اجتماعی', color: '#ff6ec7', icon: '👥' },
  messaging: { fa: 'پیام‌رسان',     color: '#5eead4', icon: '💬' },
  streaming: { fa: 'استریم/ویدیو',  color: '#ff5d73', icon: '🎬' },
  news:      { fa: 'خبری',          color: '#ffb347', icon: '📰' },
  gaming:    { fa: 'بازی',          color: '#7c5cff', icon: '🎮' },
  shopping:  { fa: 'خرید',          color: '#5cc8ff', icon: '🛒' },
  search:    { fa: 'جستجو',         color: '#a78bfa', icon: '🔍' },
  ads:       { fa: 'تبلیغات',       color: '#6b7280', icon: '📢' },
  cdn:       { fa: 'CDN/ابر',       color: '#6b7280', icon: '☁️' },
  dev:       { fa: 'برنامه‌نویسی',  color: '#34d399', icon: '💻' },
  email:     { fa: 'ایمیل',         color: '#60a5fa', icon: '📧' },
  files:     { fa: 'اشتراک فایل',   color: '#fbbf24', icon: '📁' },
  vpn:       { fa: 'VPN',           color: '#f97316', icon: '🔒' },
  reference: { fa: 'مرجع',          color: '#94a3b8', icon: '📚' },
  blog:      { fa: 'وبلاگ',         color: '#c084fc', icon: '✍️' },
  travel:    { fa: 'سفر',           color: '#06b6d4', icon: '✈️' },
  food:      { fa: 'غذا',           color: '#f59e0b', icon: '🍔' },
  other:     { fa: 'سایر',          color: '#7e87b5', icon: '🌐' },
  unknown:   { fa: 'نامشخص',        color: '#525a82', icon: '❓' },
};

// استخراج ریشه‌ی دامنه از یک آدرس کامل
export function extractRootDomain(address) {
  if (!address) return '';
  const a = String(address).toLowerCase().trim();
  if (!a) return '';
  // اگر IP است، همان برگردان
  if (/^[\d.]+$/.test(a) && a.split('.').length === 4) return a;
  if (a.includes(':') && !a.includes('.')) return a; // IPv6 بدون دامنه
  const parts = a.split('.').filter(Boolean);
  if (parts.length < 2) return a;
  // TLDهای خاص که نیاز به ۳ بخش دارن
  const specialTwo = new Set(['uk', 'jp', 'au', 'nz', 'br', 'in', 'za', 'ir']);
  if (parts.length >= 3 && parts[parts.length - 2] === 'co' && specialTwo.has(parts[parts.length - 1])) {
    return parts.slice(-3).join('.');
  }
  if (parts.length >= 3 && parts[parts.length - 2] === 'com' && specialTwo.has(parts[parts.length - 1])) {
    return parts.slice(-3).join('.');
  }
  // همچنین TLDهای دو‌بخشی مثل co.uk
  const lastTwo = parts.slice(-2).join('.');
  if (SITE_DB[lastTwo]) return lastTwo;
  // بررسی آیا خود دامنه در SITE_DB هست
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts.slice(i).join('.');
    if (SITE_DB[candidate]) return candidate;
  }
  return lastTwo;
}

// گرفتن اطلاعات کامل یک سایت: دسته، اپ، نام فارسی
export function getSiteInfo(address) {
  if (!address) return { root: '', category: 'unknown', app: null, name: '', catFa: CATEGORY_INFO.unknown.fa, color: CATEGORY_INFO.unknown.color, icon: CATEGORY_INFO.unknown.icon };
  const root = extractRootDomain(address);
  const entry = SITE_DB[root];
  if (entry) {
    const ci = CATEGORY_INFO[entry.cat] || CATEGORY_INFO.other;
    return { root, category: entry.cat, app: entry.app || null, name: entry.fa || root, catFa: ci.fa, color: ci.color, icon: ci.icon };
  }
  const ci = CATEGORY_INFO.other;
  return { root, category: 'other', app: null, name: root, catFa: ci.fa, color: ci.color, icon: ci.icon };
}

// تعداد دامنه‌های ثبت‌شده در پایگاه
export function getSiteDbSize() {
  return Object.keys(SITE_DB).length;
}
