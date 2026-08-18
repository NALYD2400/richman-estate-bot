/**
 * Richman Discord Bot — Comprehensive & Hardened HTTP REST API Server (Port 3001)
 * 
 * Security Features:
 * - Constant-time API Secret verification (prevents timing attacks)
 * - Request payload size limiting (1MB max, anti-DoS)
 * - Input validation & Snowflake ID format verification
 * - Safe error handling (no stack trace / secret disclosure)
 * - Security HTTP headers (nosniff, DENY, XSS-Protection)
 * - Topic sanitization (prevents delimiter injection)
 */
const http = require('http');
const url = require('url');
const { 
  ChannelType, 
  PermissionFlagsBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder,
  ForumLayoutType,
  AttachmentBuilder
} = require('discord.js');
const config = require('../config/constants');
const ticketHandler = require('../handlers/ticketHandler');
const supabaseService = require('./supabase');
const { updateBotPresence } = require('../events/ready');
const { formatLuxuryCarName, resolveVehiclePhotoUrl, resolveSuitePhotoUrl } = require('./vehicleUtils');

// In-Memory Rate Limiting (bucketed : 'global', 'write', ...)
const ipRateLimits = new Map();
const recentWelcomeAnnouncements = new Map();
function isRateLimited(ip, limit = 60, windowMs = 60000, bucket = 'global') {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const entry = ipRateLimits.get(key) || { count: 0, resetTime: now + windowMs };
  if (now > entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + windowMs;
  }
  entry.count++;
  ipRateLimits.set(key, entry);
  return entry.count > limit;
}

// Periodic cleanup of rate limit map
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipRateLimits.entries()) {
    if (now > entry.resetTime) ipRateLimits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

const SENSITIVE_ADMIN_ENDPOINTS = [
  '/api/manage-user-roles',
  '/api/sync-fleet-channel',
  '/api/sync-discord-suites',
  '/api/update-fleet-vehicle-status',
  '/api/delete-fleet-vehicle-message',
  '/api/update-hotel-suite-status',
  '/api/delete-hotel-suite-message',
  '/api/close-ticket',
  '/api/delete-booking-ticket',
  '/api/send-user-dm',
  '/api/sync-booking-status-action',
  '/api/send-booking-notification'
];

// Endpoints créant des ressources Discord (salons/tickets/DM) : quota strict anti-spam
const DISCORD_WRITE_ENDPOINTS = [
  '/api/create-booking-ticket',
  '/api/create-vehicle-reservation-ticket',
  '/api/send-contact-message',
  '/api/create-contact-ticket',
  '/api/send-booking-notification',
  '/api/register-member'
];

// In-Memory Token Verification Cache: token -> { isStaff, isAuthenticated, user, profile, expiresAt }
const authCache = new Map();
const AUTH_CACHE_MAX_ENTRIES = 500;

function cacheAuthResult(token, result) {
  // Purge des entrées expirées, puis de la plus ancienne si nécessaire (anti-fuite mémoire)
  const now = Date.now();
  for (const [k, v] of authCache.entries()) {
    if (v.expiresAt <= now) authCache.delete(k);
  }
  if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey) authCache.delete(oldestKey);
  }
  authCache.set(token, result);
}

// Résout l'identifiant Discord légitime d'un utilisateur Supabase authentifié (OAuth Discord).
// SÉCURITÉ : ne fait confiance aux métadonnées (user_metadata.provider_id / sub) QUE si
// l'utilisateur a réellement été créé par OAuth Discord (app_metadata / identities contrôlés
// par GoTrue). Un compte email peut forger n'importe quelle user_metadata — on ignore donc
// totalement ses métadonnées ici.
function resolveTokenDiscordId(auth) {
  if (!auth || !auth.user) return null;
  const user = auth.user;
  const meta = user.user_metadata || {};
  let identityId = null;
  if (Array.isArray(user.identities)) {
    const discIdentity = user.identities.find(i => i.provider === 'discord');
    if (discIdentity) {
      identityId = discIdentity.id || (discIdentity.identity_data && discIdentity.identity_data.provider_id) || null;
    }
  }
  const isDiscordOAuth = Boolean(identityId) ||
    (user.app_metadata && user.app_metadata.provider === 'discord') ||
    (Array.isArray(user.app_metadata && user.app_metadata.providers) && user.app_metadata.providers.includes('discord'));

  // Le discord_id du profil en base est la source de vérité (écrit par les triggers,
  // uniquement pour les comptes OAuth Discord vérifiés).
  if (auth.profile && auth.profile.discord_id) {
    return auth.profile.discord_id;
  }
  if (!isDiscordOAuth) {
    return null;
  }
  // L'identité Discord (auth.identities, contrôlée par GoTrue) prime sur
  // user_metadata, forgeable même pour un compte Discord via
  // supabase.auth.updateUser({ data: { provider_id: ... } }).
  return identityId || meta.provider_id || meta.sub || null;
}

async function authenticateRequest(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
  if (!authHeader) {
    return { isAuthenticated: false, isStaff: false, error: 'En-tête Authorization manquant' };
  }

  // 1. Direct BOT_API_SECRET check (for automated scripts, cron jobs, tests)
  if (config.API_SECRET && config.validateApiSecret(authHeader, config.API_SECRET)) {
    return { isAuthenticated: true, isStaff: true, isAdmin: true, authType: 'secret' };
  }

  // 2. Supabase JWT Check (for authenticated web panel users)
  let token = authHeader;
  if (token.startsWith('Bearer ')) {
    token = token.slice(7).trim();
  }

  const cached = authCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  if (token.split('.').length === 3 && config.SUPABASE_URL && config.SUPABASE_KEY) {
    try {
      const userRes = await fetch(`${config.SUPABASE_URL}/auth/v1/user`, {
        method: 'GET',
        headers: {
          'apikey': config.SUPABASE_KEY,
          'Authorization': `Bearer ${token}`
        }
      });

      if (userRes.ok) {
        const user = await userRes.json();
        if (user && user.id) {
          const profRes = await fetch(`${config.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=id,role,discord_id,full_name,email`, {
            method: 'GET',
            headers: {
              'apikey': config.SUPABASE_KEY,
              'Authorization': `Bearer ${config.SUPABASE_SERVICE_KEY || config.SUPABASE_KEY || token}`
            }
          });

          let profile = null;
          if (profRes.ok) {
            const profiles = await profRes.json();
            if (Array.isArray(profiles) && profiles.length > 0) {
              profile = profiles[0];
            }
          }

          const STAFF_ROLES = ['owner', 'admin', 'gerant_hotel', 'gerant_vehicules'];
          const MASTER_IDS = ['985083967642423366', '1015310406169923665'];

          // SÉCURITÉ : le statut fondateur provient UNIQUEMENT du profil en base
          // (discord_id écrit par les triggers pour un OAuth Discord vérifié).
          // Ne JAMAIS faire confiance à user_metadata.provider_id (forgeable par un compte email).
          const isMaster = Boolean(profile && MASTER_IDS.includes(profile.discord_id));

          const isStaff = isMaster || (profile && STAFF_ROLES.includes(profile.role));

          const result = {
            isAuthenticated: true,
            isStaff: Boolean(isStaff),
            user,
            profile,
            authType: 'supabase_jwt',
            expiresAt: Date.now() + 60000 // 60s cache
          };

          cacheAuthResult(token, result);
          return result;
        }
      }
    } catch (err) {
      console.warn('⚠️ Erreur vérification token Supabase:', err.message);
    }
  }

  return { isAuthenticated: false, isStaff: false, error: 'Unauthorized: Jeton ou clé API invalide' };
}

// Origins navigateur autorisées (dev local, domaine prod, previews Vercel richman-estate)
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
  /^https:\/\/([a-z0-9-]+\.)*richman-estate\.com$/i,
  /^https:\/\/richman-estate(-[a-z0-9-]+)?\.vercel\.app$/i
];

// ============================================================================
// HELPERS SHOWROOM DISCORD (partagés flotte & hôtel — ex-dupliqués par endpoint)
// ============================================================================

// Mots-clés véhicules GTA (motos / bateaux / hélicos / avions) — matching par sous-chaîne
const MOTO_KEYWORDS = [
  'akuma', 'bati', 'sanchez', 'hakuchou', 'double', 'faggio', 'daemon', 'vader',
  'nemesis', 'hexer', 'ruffian', 'pcj', 'bagger', 'thrust', 'enduro', 'lexo',
  'sovereign', 'innovation', 'chimera', 'zombie', 'defiler', 'fcr', 'diablous',
  'esskey', 'manchez', 'shotaro', 'vortex', 'avarus', 'sanctus', 'deathbike',
  'stryder', 'strider', 'shinobi', 'reever', 'bf400', 'carbonrs', 'cliffhanger', 'gargoyle',
  'nightblade', 'oppressor', 'ratbike', 'vindicator', 'wolfsbane', 'moto', 'bike', 'scooter'
];
const BOAT_KEYWORDS = ['bateau', 'boat', 'dinghy', 'jetmax', 'marquis', 'seashark', 'speeder', 'squalo', 'suntrap', 'toro', 'tropic', 'tug', 'yacht', 'sub'];
const HELI_KEYWORDS = ['helico', 'heli', 'swift', 'buzzard', 'volatus', 'supervolito', 'havok', 'frogger', 'maverick', 'cargobob', 'valkyrie', 'hunter', 'akula', 'annihilator', 'conada'];
const PLANE_KEYWORDS = ['avion', 'plane', 'luxor', 'nimbus', 'shamal', 'velum', 'dodo', 'mammatus', 'cuban800', 'alphaz1', 'howard', 'pyro', 'lazer', 'hydra', 'titan', 'alkonost', 'streamer'];

// Résolution des tags d'un forum flotte : statut + catégorie (moto/bateau/hélico/avion/classe)
function getForumTagIds(tags, isAvailable, displayClass, itemSpecs, vehicleName = '') {
  if (!tags || tags.length === 0) return [];
  const tagIds = [];

  const statusTagName = isAvailable ? 'Disponible' : 'Location';
  const statusTag = tags.find(t =>
    t.name.toLowerCase().includes(statusTagName.toLowerCase()) ||
    (isAvailable ? t.name.includes('🟢') : t.name.includes('🔴'))
  );
  if (statusTag) tagIds.push(statusTag.id);

  let rawClass = String(displayClass || '').toUpperCase().trim();
  let vType = '';
  let rawSpecsText = '';
  try {
    if (itemSpecs && typeof itemSpecs === 'string' && itemSpecs.startsWith('{')) {
      const m = JSON.parse(itemSpecs);
      if (m.class && !rawClass) rawClass = String(m.class).toUpperCase().trim();
      if (m.type) vType = String(m.type).toLowerCase().trim();
      if (m.specs_text) rawSpecsText = String(m.specs_text).toLowerCase();
    } else if (itemSpecs && typeof itemSpecs === 'string') {
      rawSpecsText = itemSpecs.toLowerCase();
    }
  } catch (e) {}

  const nameLower = String(vehicleName || '').toLowerCase().trim();
  const cUpper = rawClass || 'SUPER';

  const isMoto =
    cUpper.includes('MOTO') || cUpper.includes('CYCLE') || cUpper.includes('BIKE') ||
    ['moto', 'motorcycle', 'bike', 'cycle'].includes(vType) ||
    MOTO_KEYWORDS.some(k => nameLower.includes(k)) || rawSpecsText.includes('moto');
  const isBoat =
    cUpper.includes('BOAT') || ['bateau', 'boat'].includes(vType) ||
    BOAT_KEYWORDS.some(k => nameLower.includes(k));
  const isHeli =
    cUpper.includes('HELI') || ['helico', 'heli', 'helicopter'].includes(vType) ||
    HELI_KEYWORDS.some(k => nameLower.includes(k));
  const isPlane =
    cUpper.includes('PLANE') || ['avion', 'plane'].includes(vType) ||
    PLANE_KEYWORDS.some(k => nameLower.includes(k));

  if (isMoto) {
    const motoTag = tags.find(t => t.name.toLowerCase().includes('moto') || t.name.includes('🏍'));
    if (motoTag && !tagIds.includes(motoTag.id)) tagIds.push(motoTag.id);
  } else if (isBoat) {
    const boatTag = tags.find(t => t.name.toLowerCase().includes('bateau') || t.name.includes('🛥'));
    if (boatTag && !tagIds.includes(boatTag.id)) tagIds.push(boatTag.id);
  } else if (isHeli) {
    const heliTag = tags.find(t => t.name.toLowerCase().includes('hélico') || t.name.toLowerCase().includes('helico') || t.name.includes('🚁'));
    if (heliTag && !tagIds.includes(heliTag.id)) tagIds.push(heliTag.id);
  } else if (isPlane) {
    const planeTag = tags.find(t => t.name.toLowerCase().includes('avion') || t.name.includes('✈'));
    if (planeTag && !tagIds.includes(planeTag.id)) tagIds.push(planeTag.id);
  } else {
    let classTag = null;
    if (cUpper.includes('SUPER') || cUpper.includes('HYPER')) {
      classTag = tags.find(t => t.name.toLowerCase().includes('supercar') || t.name.includes('⚡'));
    } else if (cUpper.includes('SPORT') && !cUpper.includes('CLASSIC') && !cUpper.includes('CLASSIQUE')) {
      classTag = tags.find(t => t.name.toLowerCase().includes('sportive') || t.name.includes('🏎'));
    } else if (cUpper.includes('CLASSIC') || cUpper.includes('CLASSIQUE')) {
      classTag = tags.find(t => t.name.toLowerCase().includes('classique') || t.name.includes('🏛'));
    } else if (cUpper.includes('SUV') || cUpper.includes('4X4') || cUpper.includes('OFFROAD') || cUpper.includes('OFF_ROAD')) {
      classTag = tags.find(t => t.name.toLowerCase().includes('suv') || t.name.includes('🚙'));
    } else if (cUpper.includes('MUSCLE')) {
      classTag = tags.find(t => t.name.toLowerCase().includes('muscle') || t.name.includes('💪'));
    } else {
      classTag = tags.find(t => t.name.toLowerCase().includes('prestige') || t.name.includes('👑'));
    }
    if (classTag && !tagIds.includes(classTag.id)) tagIds.push(classTag.id);

    const carTag = tags.find(t => t.name.toLowerCase().includes('voiture') || t.name.includes('🚗'));
    if (carTag && !tagIds.includes(carTag.id)) tagIds.push(carTag.id);
  }

  return tagIds.slice(0, 5);
}

// Résolution des tags d'un forum hôtel : statut + type (villa/penthouse/suite)
function getSuiteForumTagIds(tags, isAvail, sName, sSpecs) {
  if (!tags || tags.length === 0) return [];
  const tagIds = [];

  const statusTagName = isAvail ? 'Disponible' : 'Occupée';
  const statusTag = tags.find(t =>
    t.name.toLowerCase().includes(statusTagName.toLowerCase()) ||
    (isAvail ? t.name.includes('🟢') : (t.name.includes('🔴') || t.name.toLowerCase().includes('réserv')))
  );
  if (statusTag) tagIds.push(statusTag.id);

  const nameUpper = String(sName || '').toUpperCase();
  const specsUpper = String(sSpecs || '').toUpperCase();

  if (nameUpper.includes('VILLA') || specsUpper.includes('VILLA')) {
    const vTag = tags.find(t => t.name.toLowerCase().includes('villa') || t.name.includes('🏰'));
    if (vTag && !tagIds.includes(vTag.id)) tagIds.push(vTag.id);
  } else if (nameUpper.includes('PENTHOUSE') || specsUpper.includes('PENTHOUSE')) {
    const pTag = tags.find(t => t.name.toLowerCase().includes('penthouse') || t.name.includes('🌆'));
    if (pTag && !tagIds.includes(pTag.id)) tagIds.push(pTag.id);
  } else {
    const sTag = tags.find(t => t.name.toLowerCase().includes('suite') || t.name.includes('🏨') || t.name.toLowerCase().includes('chambre'));
    if (sTag && !tagIds.includes(sTag.id)) tagIds.push(sTag.id);
  }

  return tagIds.slice(0, 5);
}

// Décode le champ specs JSON des véhicules ({ plate, class, specs_text })
function parseVehicleSpecs(item) {
  let displaySpecs = item.specs || '';
  let displayPlate = 'LXS-RICH';
  let displayClass = 'SUPER';
  try {
    if (item.specs && item.specs.startsWith('{')) {
      const meta = JSON.parse(item.specs);
      displaySpecs = meta.specs_text || '';
      displayPlate = meta.plate || 'LXS-RICH';
      displayClass = meta.class || 'SUPER';
    }
  } catch (e) {}
  return { displaySpecs, displayPlate, displayClass };
}

// Embed + bouton showroom d'un véhicule (footer = ID Supabase, base du matching thread)
function buildVehicleShowroom(item, isAvailable, { photoUrl, specsText, plate, vehicleClass } = {}) {
  const parsed = parseVehicleSpecs(item);
  const specs = specsText !== undefined ? specsText : parsed.displaySpecs;
  const displayPlate = plate !== undefined ? plate : parsed.displayPlate;
  const displayClass = vehicleClass !== undefined ? vehicleClass : parsed.displayClass;
  const luxuryTitle = formatLuxuryCarName(item.name);
  const resolvedPhoto = photoUrl !== undefined ? photoUrl : resolveVehiclePhotoUrl(item.name, item.specs);

  const embed = new EmbedBuilder()
    .setColor(isAvailable ? 0x10B981 : 0xEF4444)
    .setTitle(`${isAvailable ? '🟢 DISPONIBLE' : '🔴 EN LOCATION'} • ${luxuryTitle.toUpperCase()}`)
    .addFields(
      { name: '🏷️ Tarif Jour', value: `\`${item.price || 'Sur devis'}\``, inline: true },
      { name: '🔢 Plaque', value: `\`${displayPlate}\``, inline: true },
      { name: '⚡ Catégorie', value: `\`${displayClass}\``, inline: true },
      { name: '⚙️ Motorisation & Specs', value: specs || 'Motorisation préparée haute performance, finitions carbone et intérieur cuir sur mesure.', inline: false }
    )
    .setFooter({ text: `ID: #${item.id.slice(0, 8).toUpperCase()} • Richman Estate Showroom` })
    .setImage(resolvedPhoto)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🌐 Réserver sur le Site')
      .setStyle(ButtonStyle.Link)
      .setURL(`${config.SITE_URL}/vehicules.html?select=${encodeURIComponent(String(item.name).toLowerCase().trim())}`)
  );

  return { embed, row, luxuryTitle };
}

// Embed + bouton showroom d'une suite (footer = ID Supabase)
async function buildSuiteShowroom(item, isAvailable, { photoUrl, specsText } = {}) {
  const specs = specsText !== undefined ? specsText : (item.specs || '');
  const suiteTitle = String(item.name || 'Suite').trim();
  const resolvedPhoto = photoUrl !== undefined ? photoUrl : resolveSuitePhotoUrl(item.name, item.media_urls);

  const embed = new EmbedBuilder()
    .setColor(isAvailable ? 0x10B981 : 0xEF4444)
    .setTitle(`${isAvailable ? '🟢 DISPONIBLE' : '🔴 OCCUPÉE'} • ${suiteTitle.toUpperCase()}`)
    .addFields(
      { name: '🏷️ Tarif Nuit', value: `\`${item.price || 'Sur devis'}\``, inline: true },
      { name: '📍 Domaine', value: '`Richman Hills • Domaine Privé`', inline: true },
      { name: '✨ Caractéristiques', value: specs || 'Hébergement haut de gamme, service hôtelier d\'exception.', inline: false }
    )
    .setFooter({ text: `ID: #${(item.id || '').slice(0, 8).toUpperCase()} • Richman Estate Hotel & Suites` })
    .setTimestamp();

  const files = [];
  if (resolvedPhoto) {
    if (resolvedPhoto.startsWith('data:image/')) {
      try {
        const match = resolvedPhoto.match(/^data:image\/([a-zA-Z0-9\+\-]+);base64,(.+)$/);
        if (match) {
          const rawExt = match[1].toLowerCase();
          const ext = rawExt.includes('png') ? 'png' : rawExt.includes('webp') ? 'webp' : 'jpg';
          const buffer = Buffer.from(match[2], 'base64');
          const safeId = (item.id || 'suite').slice(0, 8);
          const filename = `suite_${safeId}.${ext}`;
          const attachment = new AttachmentBuilder(buffer, { name: filename });
          embed.setImage(`attachment://${filename}`);
          files.push(attachment);
        }
      } catch (e) {
        console.warn('[Suite Attachment Build Error]:', e.message);
      }
    } else if (resolvedPhoto.startsWith('http')) {
      try {
        const res = await fetch(resolvedPhoto);
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          const safeId = (item.id || 'suite').slice(0, 8);
          const filename = `suite_${safeId}.jpg`;
          const attachment = new AttachmentBuilder(buffer, { name: filename });
          embed.setImage(`attachment://${filename}`);
          files.push(attachment);
        } else {
          embed.setImage(resolvedPhoto);
        }
      } catch (e) {
        console.warn('[Suite HTTP Image Fetch Error]:', e.message);
        embed.setImage(resolvedPhoto);
      }
    }
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🌐 Réserver sur le Site')
      .setStyle(ButtonStyle.Link)
      .setURL(`${config.SITE_URL}/suites.html?select=${encodeURIComponent(suiteTitle.toLowerCase().trim())}`)
  );

  return { embed, row, files, suiteTitle };
}

// Union des threads actifs + archivés d'un forum
async function fetchAllForumThreads(channel) {
  const active = await channel.threads.fetchActive().catch(() => ({ threads: new Map() }));
  const archived = await channel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
  return [...active.threads.values(), ...archived.threads.values()];
}

// Retrouve le thread showroom d'un item par son ID Supabase unique dans le footer du message starter
async function findThreadByTarget(channel, targetIdTag) {
  if (!targetIdTag) return null;
  const allThreads = await fetchAllForumThreads(channel);

  for (const th of allThreads) {
    try {
      const starter = await th.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds && starter.embeds[0] && starter.embeds[0].footer && starter.embeds[0].footer.text && starter.embeds[0].footer.text.includes(targetIdTag)) {
        return th;
      }
    } catch (e) {}
  }

  return null;
}

// Supprime tous les threads showroom correspondant à un ID Supabase
async function deleteThreadsByTarget(channel, targetIdTag) {
  const allThreads = await fetchAllForumThreads(channel);
  for (const th of allThreads) {
    let shouldDelete = th.name.includes(targetIdTag);
    if (!shouldDelete) {
      const starter = await th.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds && starter.embeds[0] && starter.embeds[0].footer && starter.embeds[0].footer.text.includes(targetIdTag)) {
        shouldDelete = true;
      }
    }
    if (shouldDelete) {
      await th.delete('Supprimé du catalogue Richman Estate').catch(() => {});
    }
  }
}

function startApiServer(client, customPort = null) {
  const server = http.createServer(async (req, res) => {
    // Security HTTP Response Headers (CORS restreint aux origins de confiance)
    const requestOrigin = req.headers['origin'];
    if (requestOrigin && ALLOWED_ORIGIN_PATTERNS.some(re => re.test(requestOrigin))) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Anti-spoofing rate-limit : derrière un proxy (Render/Vercel), l'IP réelle est
    // le DERNIER élément de X-Forwarded-For (ajouté par le proxy) ; les premiers sont
    // contrôlés par le client (rotation = contournement des quotas). Sans proxy, on
    // utilise l'adresse du socket.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',');
    const clientIp = (xff.length && xff[xff.length - 1].trim()) || req.socket.remoteAddress || '127.0.0.1';
    if (isRateLimited(clientIp, 120, 60000)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Trop de requêtes, veuillez patienter (Rate limit dépassé).' }));
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '/';
    const query = parsedUrl.query || {};

    // Quota strict pour les endpoints créant des salons/tickets/DM Discord (anti-spam)
    if (DISCORD_WRITE_ENDPOINTS.includes(pathname) && isRateLimited(clientIp, 8, 60000, 'discord-write')) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Trop de demandes de création simultanées. Réessayez dans une minute.' }));
    }

    const sendJSON = (statusCode, data) => {
      if (res.writableEnded) return;
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    const sendError = (statusCode, userMessage, logError = null) => {
      if (logError) {
        console.error(`❌ [API Error] ${req.method} ${pathname} :`, logError);
      }
      sendJSON(statusCode, { error: userMessage });
    };

    // Public Health Check
    if (pathname === '/' || pathname === '/health' || pathname === '/ping') {
      return sendJSON(200, {
        status: 'online',
        service: 'richman-discord-bot',
        bot: client.user?.tag || 'connecting',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    }

    // Authentication Guard on Sensitive Endpoints
    if (SENSITIVE_ADMIN_ENDPOINTS.includes(pathname)) {
      const auth = await authenticateRequest(req);
      if (!auth.isStaff) {
        return sendError(401, 'Unauthorized: Privilèges staff ou clé API secrète requis');
      }
      req.auth = auth;
    }

    // Role Verification Helper
    const executeCheckRoles = async (discordId, providerToken) => {
      if (!discordId) return sendError(400, 'Paramètre discordId requis');
      if (!config.isValidSnowflake(discordId)) {
        return sendJSON(200, { onServer: false, inGuild: false, hasMembreRole: false, hasCitoyenRole: false, canContact: false, roles: [] });
      }

      try {
        const guild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
        if (!guild) return sendError(503, 'Serveur Discord inaccessible');

        let member = await guild.members.fetch(discordId).catch(() => null);

        if (!member && providerToken && config.TOKEN) {
          try {
            const joinResp = await fetch(`https://discord.com/api/guilds/${guild.id}/members/${discordId}`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bot ${config.TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ access_token: providerToken })
            });
            if (joinResp.status === 201 || joinResp.status === 204) {
              member = await guild.members.fetch(discordId).catch(() => null);
            }
          } catch (joinErr) {
            console.warn("⚠️ Échec ajout OAuth membre :", joinErr.message);
          }
        }

        if (!member) {
          return sendJSON(200, {
            onServer: false,
            inGuild: false,
            hasMembreRole: false,
            hasCitoyenRole: false,
            canContact: false,
            nickname: null,
            roles: []
          });
        }

        const hasMembreRole = config.ROLE_MEMBRE_ID ? member.roles.cache.has(config.ROLE_MEMBRE_ID) : true;
        const hasCitoyenRole = config.ROLE_CITOYEN_ID ? member.roles.cache.has(config.ROLE_CITOYEN_ID) : member.roles.cache.some(r => r.name.includes('Citoyen'));
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 128 });

        let roles = [];
        try {
          roles = [...member.roles.cache.values()]
            .filter(r => r.name !== '@everyone')
            .map(r => ({
              id: r.id,
              name: r.name,
              color: (r.hexColor && r.hexColor !== '#000000') ? r.hexColor : '#a1a1aa',
              position: r.position || 0
            }))
            .sort((a, b) => b.position - a.position);
        } catch (e) {}

        const REQUIRED_CONTACT_ROLES = [
          '1537437506235269262',
          '1537195723211153511',
          '1537194801512980561',
          '1537194801512980560',
          config.ROLE_CITOYEN_ID,
          config.ROLE_MEMBRE_ID,
          config.ROLE_OWNER_ID,
          config.ROLE_ADMIN_ID,
          config.ROLE_VIP_ID,
          config.ROLE_GERANT_HOTEL_ID,
          config.ROLE_GERANT_VEHICULES_ID,
          config.ROLE_DIAMOND_VIP_ID,
          config.ROLE_PARTENAIRE_ID
        ].filter(Boolean);

        const canContact = member.roles.cache.some(r => REQUIRED_CONTACT_ROLES.includes(r.id)) || (member.id === config.MASTER_OWNER_ID);

        return sendJSON(200, {
          onServer: true,
          inGuild: true,
          hasMembreRole,
          hasCitoyenRole,
          canContact,
          nickname: member.displayName || member.user.username,
          avatarUrl,
          roles
        });
      } catch (err) {
        return sendError(500, 'Erreur lors de la vérification des rôles', err.message);
      }
    };

    // Body Parser with 1MB Anti-DoS Protection
    let body = '';
    let bodySizeExceeded = false;

    req.on('data', chunk => {
      body += chunk;
      if (body.length > config.MAX_PAYLOAD_SIZE) {
        bodySizeExceeded = true;
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (bodySizeExceeded) {
        return sendError(413, 'Payload trop volumineux (max 1 Mo)');
      }

      let parsedBody = {};
      if (body) {
        try {
          parsedBody = JSON.parse(body);
        } catch (e) {
          return sendError(400, 'Payload JSON invalide');
        }
      }

      // 0. Gardes anti-abuse des endpoints de création de tickets / DM Discord
      //    (anti-phishing) : un discord_id fourni doit être CELUI de l'appelant,
      //    sauf staff/secret. Les invités sans discord_id restent acceptés
      //    (ticket sans DM), toujours sous quota.
      if ((pathname === '/api/create-booking-ticket' || pathname === '/api/create-vehicle-reservation-ticket' ||
           pathname === '/api/send-contact-message' || pathname === '/api/create-contact-ticket') && req.method === 'POST') {
        const bodyDiscordId = String(parsedBody.discordId || parsedBody.discord_id || '').trim();
        if (bodyDiscordId && config.isValidSnowflake(bodyDiscordId)) {
          const auth = await authenticateRequest(req);
          if (!auth.isAuthenticated) {
            return sendError(401, 'Unauthorized: Session membre ou clé API requise pour lier un compte Discord');
          }
          if (!auth.isStaff) {
            const tokenDiscordId = resolveTokenDiscordId(auth);
            if (!tokenDiscordId || String(tokenDiscordId).trim() !== bodyDiscordId) {
              return sendError(403, 'Forbidden: Vous ne pouvez créer un ticket/DM que pour votre propre compte Discord');
            }
          }
        }
      }

      // 1. Check User Roles Endpoint (POST preferred, GET without providerToken allowed for read-only ID)
      if (pathname === '/api/check-user-roles') {
        // Authentification obligatoire : empêche l'énumération anonyme des rôles/pseudos/avatars
        const auth = await authenticateRequest(req);
        if (!auth.isAuthenticated) {
          return sendError(401, 'Unauthorized: Session membre ou clé API requise pour consulter les rôles');
        }

        // Anti-énumération : un membre ne peut interroger QUE son propre discord_id
        // (staff/secret autorisés à consulter n'importe quel membre).
        if (!auth.isStaff) {
          const queriedId = req.method === 'POST' ? parsedBody.discordId : query.discordId;
          const ownId = resolveTokenDiscordId(auth);
          if (!ownId || String(queriedId || '').trim() !== String(ownId).trim()) {
            return sendError(403, 'Forbidden: Vous ne pouvez consulter que vos propres rôles');
          }
        }

        if (req.method === 'POST') {
          return executeCheckRoles(parsedBody.discordId, parsedBody.providerToken);
        } else if (req.method === 'GET') {
          if (query.providerToken) {
            return sendError(400, 'Sécurité : Le token OAuth ne doit pas être transmis en GET. Utilisez POST.');
          }
          return executeCheckRoles(query.discordId, null);
        } else {
          return sendError(405, 'Méthode non autorisée');
        }
      }

      // 1b. Direct Web RP Registration & Auto Discord Onboarding
      if ((pathname === '/api/register-member' || pathname === '/api/complete-web-registration') && req.method === 'POST') {
        try {
          const { discordId, providerToken, firstName, lastName, prenom, nom, rpId, idCitizen, acceptedRules, userId } = parsedBody;

          if (!discordId || !config.isValidSnowflake(discordId)) {
            return sendError(400, 'Identifiant Discord (discordId) valide requis');
          }

          const rawFirst = String(firstName || prenom || '').trim();
          const rawLast = String(lastName || nom || '').trim();
          const rawId = String(rpId || idCitizen || parsedBody.id || parsedBody.reg_phone || '').trim();

          const cleanFirst = rawFirst.replace(/[^a-zA-ZÀ-ÿ0-9 -]/g, '').slice(0, 15).trim();
          const cleanLast = rawLast.replace(/[^a-zA-ZÀ-ÿ0-9 -]/g, '').slice(0, 15).trim();
          const cleanId = rawId.replace(/[^0-9]/g, '').slice(0, 10).trim();

          if (!cleanFirst || !cleanLast) {
            return sendError(400, 'Prénom et Nom RP obligatoires (lettres, tirets et chiffres autorisés).');
          }

          const isAccepted = acceptedRules === true || acceptedRules === 'true' || acceptedRules === 1 || 
                             parsedBody.rulesAccepted === true || parsedBody.rulesAccepted === 'true' || parsedBody.rulesAccepted === 1;

          if (!isAccepted) {
            return sendError(400, 'Vous devez obligatoirement accepter le règlement de Richman Estate pour valider votre enregistrement.');
          }

          // Authentification obligatoire + preuve de propriété du compte Discord :
          // un JWT doit correspondre au discordId fourni (sinon n'importe qui pourrait
          // renommer un membre, lui attribuer des rôles et écraser son profil).
          const auth = await authenticateRequest(req);
          if (!auth.isAuthenticated) {
            return sendError(401, 'Unauthorized: Session membre ou clé API requise pour l\'enregistrement RP');
          }
          if (auth.authType === 'supabase_jwt') {
            const tokenDiscordId = resolveTokenDiscordId(auth);
            if (!tokenDiscordId || String(tokenDiscordId).trim() !== String(discordId).trim()) {
              return sendError(403, 'Forbidden: Vous ne pouvez enregistrer que votre propre compte Discord');
            }
            if (userId && auth.user?.id && String(auth.user.id).trim() !== String(userId).trim()) {
              return sendError(403, 'Forbidden: ID utilisateur incompatible avec la session authentifiée');
            }
          }

          const baseName = `${cleanFirst} ${cleanLast}`;
          const fullNickname = cleanId ? `${baseName} | ${cleanId}` : baseName;
          const safeNickname = fullNickname.slice(0, 32);

          const guild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
          if (!guild) return sendError(503, 'Serveur Discord introuvable');

          let member = await guild.members.fetch(discordId).catch(() => null);

          // If member is not yet in guild and providerToken is supplied, auto-join them
          if (!member && providerToken && config.TOKEN) {
            try {
              const joinResp = await fetch(`https://discord.com/api/guilds/${guild.id}/members/${discordId}`, {
                method: 'PUT',
                headers: {
                  'Authorization': `Bot ${config.TOKEN}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ access_token: providerToken })
              });
              if (joinResp.status === 201 || joinResp.status === 204) {
                member = await guild.members.fetch(discordId).catch(() => null);
              }
            } catch (joinErr) {
              console.warn("⚠️ Échec ajout automatique membre Discord :", joinErr.message);
            }
          }

          if (member) {
            // 1. Rename member on Discord
            if (member.manageable) {
              await member.setNickname(safeNickname).catch(err => {
                console.warn("⚠️ Impossible de changer le pseudo Discord :", err.message);
              });
            }

            // 2. Assign Membre role (Règlement accepté)
            const roleMembreId = config.ROLE_MEMBRE_ID || '1537195723211153511';
            const membreRole = guild.roles.cache.get(roleMembreId);
            if (membreRole && guild.members.me?.roles.highest.position > membreRole.position) {
              await member.roles.add(membreRole).catch(e => console.warn("Erreur attribution rôle Membre:", e.message));
            }

            // 3. Assign Citoyen role (Enregistré)
            const roleCitoyenId = config.ROLE_CITOYEN_ID || '1537437506235269262';
            let citoyenRole = guild.roles.cache.get(roleCitoyenId);
            if (!citoyenRole) {
              citoyenRole = [...guild.roles.cache.values()].find(r => r.name && (r.name.includes('Citoyen') || r.name.includes('Enregistré')));
            }
            if (citoyenRole && guild.members.me?.roles.highest.position > citoyenRole.position) {
              await member.roles.add(citoyenRole).catch(e => console.warn("Erreur attribution rôle Citoyen:", e.message));
            }
          }

          const avatarUrl = member ? member.user.displayAvatarURL({ extension: 'png', size: 128 }) : `https://cdn.discordapp.com/embed/avatars/0.png`;

          // 4. Update/Upsert Supabase Profile
          const effectiveUserId = (auth.authType === 'supabase_jwt' && auth.user?.id) ? auth.user.id : (userId ? String(userId).trim() : null);
          if (effectiveUserId) {
            await supabaseService.supabaseRequest(`profiles?id=eq.${encodeURIComponent(effectiveUserId)}`, 'PATCH', {
              discord_id: discordId,
              full_name: baseName,
              first_name: cleanFirst,
              last_name: cleanLast,
              rp_id: cleanId || null,
              avatar_url: avatarUrl
            }).catch(e => console.warn("Erreur update profile Supabase:", e.message));
          } else {
            await supabaseService.updateUserProfile(discordId, {
              full_name: baseName,
              first_name: cleanFirst,
              last_name: cleanLast,
              rp_id: cleanId || null,
              avatar_url: avatarUrl
            }).catch(e => console.warn("Erreur update profile Supabase:", e.message));
          }

          // 5. Send Welcome Announcement Embed to #arrivee (with 60s anti-duplicate debounce)
          const now = Date.now();
          const lastWelcome = recentWelcomeAnnouncements.get(discordId) || 0;
          if (now - lastWelcome > 60000) {
            recentWelcomeAnnouncements.set(discordId, now);
            if (recentWelcomeAnnouncements.size > 500) {
              for (const [id, ts] of recentWelcomeAnnouncements.entries()) {
                if (now - ts > 300000) recentWelcomeAnnouncements.delete(id);
              }
            }

            const welcomeChannelId = config.WELCOME_CHANNEL_ID || '1537434439338958848';
            const welcomeChannel = guild?.channels?.cache ? guild.channels.cache.get(welcomeChannelId) : null;
            if (welcomeChannel && welcomeChannel.isTextBased()) {
              try {
                const welcomeEmbed = new EmbedBuilder()
                  .setAuthor({ name: safeNickname, iconURL: avatarUrl })
                  .setTitle('Ho ! Un nouveau membre !')
                  .setDescription(
                    `🎉 Bienvenue <@${discordId}> sur le serveur **Richman Estate** ! 🎉\n\n` +
                    `Votre compte est désormais activé avec le nom **${safeNickname}**.`
                  )
                  .setColor('#5865F2')
                  .setThumbnail(avatarUrl)
                  .setFooter({ text: 'Richman Estate • Conciergerie Privée' })
                  .setTimestamp();

                await welcomeChannel.send({
                  content: `<@${discordId}>`,
                  embeds: [welcomeEmbed]
                }).catch(err => console.warn("⚠️ Impossible d'envoyer l'annonce de bienvenue :", err.message));
              } catch (err) {
                console.warn("⚠️ Erreur création message bienvenue :", err.message);
              }
            }
          }

          // 6. Log activity
          await supabaseService.supabaseRequest('logs', 'POST', {
            action: `Enregistrement RP Web validé : ${safeNickname}`,
            user_name: safeNickname,
            type: 'success',
            details: { discord_id: discordId, first_name: cleanFirst, last_name: cleanLast, rp_id: cleanId }
          }).catch(() => {});

          return sendJSON(200, {
            success: true,
            nickname: safeNickname,
            baseName,
            firstName: cleanFirst,
            lastName: cleanLast,
            rpId: cleanId,
            avatarUrl,
            onServer: Boolean(member),
            hasMembreRole: true,
            hasCitoyenRole: true
          });
        } catch (err) {
          return sendError(500, "Erreur lors de l'enregistrement RP", err.message);
        }
      }

      // 2. Create Booking Ticket
      if ((pathname === '/api/create-booking-ticket' || pathname === '/api/create-vehicle-reservation-ticket') && req.method === 'POST') {
        try {
          const result = await ticketHandler.createBookingTicket(client, parsedBody);
          return sendJSON(200, result);
        } catch (err) {
          return sendError(500, 'Erreur lors de la création du salon ticket', err.message);
        }
      }

      // 3. Send Contact Message / Create Contact Ticket
      if ((pathname === '/api/send-contact-message' || pathname === '/api/create-contact-ticket') && req.method === 'POST') {
        try {
          const { contact_id, name, phone, subject, message } = parsedBody;
          const discordId = String(parsedBody.discordId || parsedBody.discord_id || parsedBody.discord || '').trim();
          const guild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
          if (!guild) return sendError(503, 'Serveur Discord introuvable');

          const safeName = String(name || 'client').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 12);
          const shortRef = contact_id ? String(contact_id).slice(0, 6).toLowerCase() : Math.random().toString(36).slice(2, 6);
          const channelName = `contact-${safeName}-${shortRef}`;

          const STAFF_ROLES = [
            config.ROLE_OWNER_ID,
            config.ROLE_ADMIN_ID,
            config.ROLE_GERANT_HOTEL_ID,
            config.ROLE_GERANT_VEHICULES_ID,
            config.ROLE_STAFF_ID,
            config.ROLE_CONCIERGE_ID
          ].filter(Boolean);

          const permissionOverwrites = [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: guild.members.me ? guild.members.me.id : client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ManageChannels
              ]
            }
          ];

          STAFF_ROLES.forEach(rId => {
            if (guild.roles.cache.has(rId)) {
              permissionOverwrites.push({
                id: rId,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.EmbedLinks
                ]
              });
            }
          });

          if (discordId && config.isValidSnowflake(discordId)) {
            try {
              const member = await guild.members.fetch(discordId).catch(() => null);
              const userObj = member ? member.user : await client.users.fetch(discordId).catch(() => null);
              if (userObj) {
                permissionOverwrites.push({
                  id: userObj.id,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.AttachFiles
                  ]
                });
              }
            } catch (e) {}
          }

          const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: config.CAT_TICKETS_CONTACT_ID || null,
            topic: `contact_id:${config.sanitizeTopicValue(contact_id)}|discord_id:${config.sanitizeTopicValue(discordId)}|client_name:${config.sanitizeTopicValue(name)}|subject:${config.sanitizeTopicValue(subject)}|type:contact`,
            permissionOverwrites
          });

          const contactEmbed = new EmbedBuilder()
            .setColor(0xC5A880)
            .setTitle(`🛎️ NOUVEAU MESSAGE DE CONTACT • #${shortRef.toUpperCase()}`)
            .setDescription(
              `Une nouvelle demande a été envoyée depuis le formulaire de contact.\n\n` +
              `👤 **Client RP :** **${String(name || 'Anonyme').slice(0, 50)}** ${discordId ? `(<@${discordId}>)` : ''}\n` +
              `📞 **Contact :** \`${String(phone || 'Non renseigné').slice(0, 30)}\`\n` +
              `🏷️ **Objet :** \`${String(subject || 'Demande générale').slice(0, 100)}\`\n` +
              (discordId ? `🆔 **Discord ID :** \`${discordId}\`\n` : '') +
              `\n💬 **Message transmis :**\n> ${message ? String(message).slice(0, 1500).replace(/\n/g, '\n> ') : 'Aucun détail fourni.'}`
            )
            .setThumbnail('https://ghbeopdnfdxuqfjzmmeb.supabase.co/storage/v1/object/public/public_assets/logo.webp')
            .setFooter({ text: `Message #${shortRef.toUpperCase()} • Richman Estate` })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('btn_ticket_close')
              .setLabel('Clôturer le Ticket')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('🔒')
          );

          await ticketChannel.send({ embeds: [contactEmbed], components: [row] });

          if (discordId && config.isValidSnowflake(discordId)) {
            try {
              const targetUser = await client.users.fetch(discordId).catch(() => null);
              if (targetUser) {
                const dmEmbed = new EmbedBuilder()
                  .setColor(0xC5A880)
                  .setTitle(`🛎️ MESSAGE BIEN REÇU • #${shortRef.toUpperCase()}`)
                  .setDescription(
                    `Bonjour **${String(name || 'Citoyen').slice(0, 50)}**,\n\n` +
                    `Votre message concernant **${String(subject || 'Demande générale').slice(0, 50)}** a bien été transmis à l'équipe Richman !\n\n` +
                    `• **Numéro de Référence :** \`#${shortRef.toUpperCase()}\`\n` +
                    `• **Contact :** \`${String(phone || 'Non renseigné').slice(0, 30)}\`\n` +
                    `• **Statut actuel :** ⏳ *En attente de prise en charge*\n\n` +
                    `💬 **Votre salon dédié :** <#${ticketChannel.id}>\n\n` +
                    `Vous pouvez échanger directement avec l'équipe Richman dans votre salon <#${ticketChannel.id}>.`
                  )
                  .setFooter({ text: 'Richman Estate' })
                  .setTimestamp();

                await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
              }
            } catch (e) {}
          }

          return sendJSON(200, {
            success: true,
            channelId: ticketChannel.id,
            guildId: guild.id,
            channelName
          });
        } catch (err) {
          return sendError(500, 'Erreur lors de la création du contact', err.message);
        }
      }

      // 4. Send Booking Notification
      if (pathname === '/api/send-booking-notification' && req.method === 'POST') {
        try {
          const { type, client_name, item_name, amount, dates, phone, notes, booking_id } = parsedBody;
          const isHotel = (type === 'suite' || type === 'appartement' || type === 'chambre');
          const channelId = isHotel 
            ? config.CHANNEL_RESERVATIONS_HOTEL 
            : (config.CHANNEL_DEMANDES_LOCATIONS || config.CHANNEL_ADMIN_LOGS);

          if (!channelId) return sendJSON(200, { success: true, message: 'Notification skipped (no channel configured)' });

          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel) return sendJSON(200, { success: true, message: 'Notification skipped (channel not accessible)' });

          const embed = new EmbedBuilder()
            .setColor(isHotel ? 0xA855F7 : 0xC5A880)
            .setTitle(isHotel ? '🏨 NOUVELLE RÉSERVATION HÔTEL & SUITE' : '🚗 NOUVELLE DEMANDE DE LOCATION SUPERCAR')
            .setDescription(
              `Une nouvelle demande a été soumise sur la plateforme **Richman Estate RP**.\n\n` +
              `**Dossier :** \`#RES-${booking_id ? String(booking_id).slice(0, 6).toUpperCase() : 'RP'}\`\n` +
              `**Client :** **${String(client_name || 'Citoyen RP').slice(0, 50)}**\n` +
              `**Élément :** **${String(item_name || 'Non spécifié').slice(0, 50)}**\n` +
              `**Montant estimé :** **${String(amount || 'Sur devis').slice(0, 30)}**\n` +
              `**Dates :** ${String(dates || 'Immédiat').slice(0, 50)}\n` +
              (phone ? `**Contact :** \`${String(phone).slice(0, 30)}\`\n` : '') +
              (notes ? `**Notes :** *${String(notes).slice(0, 500)}*\n` : '')
            )
            .setThumbnail('https://ghbeopdnfdxuqfjzmmeb.supabase.co/storage/v1/object/public/public_assets/logo.webp')
            .setFooter({ text: 'Richman Estate • Support & Réservations 24/7' })
            .setTimestamp();

          await channel.send({ embeds: [embed] }).catch(() => {});
          return sendJSON(200, { success: true, channelId });
        } catch (err) {
          return sendError(500, 'Erreur envoi notification réservation', err.message);
        }
      }

      // 5. Send Admin Log
      if (pathname === '/api/send-admin-log' && req.method === 'POST') {
        try {
          const auth = await authenticateRequest(req);
          if (!auth.isStaff) {
            return sendError(401, 'Unauthorized: Privilèges staff requis pour enregistrer un log d\'administration');
          }

          const { action, user_name, type, details } = parsedBody;
          const channel = await client.channels.fetch(config.CHANNEL_ADMIN_LOGS).catch(() => null);
          if (channel) {
            const logEmbed = new EmbedBuilder()
              .setColor(type === 'danger' ? 0xEF4444 : (type === 'warning' ? 0xF59E0B : 0x10B981))
              .setTitle(`🔒 LOG ADMINISTRATION STAFF • ${type ? String(type).toUpperCase() : 'INFO'}`)
              .setDescription(
                `**Opérateur :** \`${String(user_name || (auth.user?.email || 'Staff')).slice(0, 50)}\`\n` +
                `**Action :** **${String(action || 'Action').slice(0, 100)}**\n` +
                (details ? `**Détails :** \`\`\`json\n${typeof details === 'object' ? JSON.stringify(details, null, 2).slice(0, 1500) : String(details).slice(0, 1500)}\n\`\`\`` : '')
              )
              .setFooter({ text: 'Richman Estate Security Sentinel' })
              .setTimestamp();

            await channel.send({ embeds: [logEmbed] });
          }
          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur enregistrement log staff', err.message);
        }
      }

      // 6. Send User DM
      if (pathname === '/api/send-user-dm' && req.method === 'POST') {
        try {
          const { discordId, message, title, type, photoUrl, itemName } = parsedBody;
          if (!discordId || !message) return sendError(400, 'discordId et message requis');
          if (!config.isValidSnowflake(discordId)) return sendError(400, 'Format discordId invalide');

          const targetUser = await client.users.fetch(discordId).catch(() => null);
          if (!targetUser) return sendError(404, 'Utilisateur Discord introuvable');

          const color = type === 'success' ? 0x10B981 : (type === 'danger' ? 0xEF4444 : 0xC5A880);
          const resolvedPhoto = photoUrl || (itemName ? resolveVehiclePhotoUrl(itemName) : null);

          const dmEmbed = new EmbedBuilder()
            .setColor(color)
            .setTitle(String(title || '📩 Message de l\'équipe Richman Estate').slice(0, 100))
            .setDescription(`> ${String(message).slice(0, 2000).replace(/\n/g, '\n> ')}`)
            .setFooter({ text: 'Richman Estate' })
            .setTimestamp();

          if (resolvedPhoto && String(resolvedPhoto).startsWith('http')) {
            dmEmbed.setImage(resolvedPhoto);
          }

          await targetUser.send({ embeds: [dmEmbed] });
          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur envoi DM utilisateur', err.message);
        }
      }

      // 7. Sync Booking Status Action
      if (pathname === '/api/sync-booking-status-action' && req.method === 'POST') {
        try {
          const { booking_id, status, client_name, item_name, type, discord_id, staff_name } = parsedBody;
          if (!booking_id || !status) return sendError(400, 'booking_id et status requis');

          const isConfirmed = status === 'confirmed';
          const isCompleted = status === 'completed' || status === 'returned';
          const isClosed = status === 'closed';
          const isSuite = type === 'suite';
          const displayName = String(item_name || (isSuite ? 'Hébergement' : 'Véhicule')).slice(0, 50);

          let foundTicketChannel = null;
          for (const guild of client.guilds.cache.values()) {
            if (booking_id) {
              const ch = guild.channels.cache.find(c => c.isTextBased() && c.topic && c.topic.includes(`booking_id:${booking_id}`));
              if (ch) { foundTicketChannel = ch; break; }
            }
          }

          const luxuryTitle = isSuite ? displayName : formatLuxuryCarName(displayName);

          if (foundTicketChannel) {
            let embedTitle = '❌ DEMANDE DE RÉSERVATION REFUSÉE';
            let embedDesc = `Dossier refusé par **${String(staff_name || 'Staff Richman').slice(0, 50)}**.\nLe statut a été mis à jour et le client prévenu.`;
            let embedColor = 0xEF4444;
            let components = [];

            if (isCompleted) {
              embedTitle = isSuite ? '🔑 SÉJOUR CLÔTURÉ • CHECK-OUT EFFECTUÉ' : '🔄 LOCATION TERMINÉE • VÉHICULE RESTITUÉ';
              embedDesc = isSuite
                ? `Check-out validé par **${String(staff_name || 'Staff Richman').slice(0, 50)}**.\n🏨 L'hébergement **${luxuryTitle}** a été libéré et inspecté.\n✅ Caution débloquée et séjour clôturé avec succès.`
                : `Restitution validée par **${String(staff_name || 'Staff Richman').slice(0, 50)}**.\n🚗 Le véhicule **${luxuryTitle}** a été réceptionné et réintégré à la flotte.\n✅ Caution débloquée et location clôturée avec succès.`;
              embedColor = 0x10B981;
            } else if (isConfirmed) {
              embedTitle = isSuite ? '✅ RÉSERVATION ACCEPTÉE ET VALIDÉE' : '✅ LOCATION ACCEPTÉE ET VALIDÉE';
              embedDesc = `Dossier validé par **${String(staff_name || 'Staff Richman').slice(0, 50)}**.\n\n` +
                (isSuite
                  ? `🏨 **Hébergement :** La réservation pour **${luxuryTitle}** a été confirmée.\n🔑 **Remise des clés :** Vous pouvez dès à présent convenir des modalités d'arrivée directement ici dans ce salon.`
                  : `🔑 **Mise à disposition :** Le statut du véhicule **${luxuryTitle}** a été passé en **En Location**.\n💬 **Remise des clés :** Vous pouvez dès à présent convenir du lieu et de l'heure du rendez-vous directement ici dans ce salon.`
                );
              embedColor = 0x10B981;

              // Move to Returns Category
              if (config.CAT_TICKETS_RETOURS_ID && foundTicketChannel.setParent) {
                foundTicketChannel.setParent(config.CAT_TICKETS_RETOURS_ID, { lockPermissions: false }).catch(() => {});
              }

              const invoiceUrl = `${config.SITE_URL}/client.html?invoice=${booking_id || 'new'}`;
              const returnActionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`btn_ticket_return_${booking_id || 'new'}`)
                  .setLabel(isSuite ? '🔑 Valider le Check-out' : '🔄 Valider le Retour')
                  .setStyle(ButtonStyle.Success)
                  .setEmoji(isSuite ? '🔑' : '🔄'),
                new ButtonBuilder()
                  .setLabel('Facture')
                  .setStyle(ButtonStyle.Link)
                  .setURL(invoiceUrl)
                  .setEmoji('📄'),
                new ButtonBuilder()
                  .setCustomId('btn_ticket_close')
                  .setLabel('🔒 Clôturer')
                  .setStyle(ButtonStyle.Secondary)
                  .setEmoji('🔒')
              );
              components = [returnActionRow];
            } else if (isClosed) {
              embedTitle = '🔒 DOSSIER CLÔTURÉ & ARCHIVÉ';
              embedDesc = `Le dossier a été clôturé par **${String(staff_name || 'Staff Richman').slice(0, 50)}**.\n⚠️ **Suppression de ce salon dans 3 secondes...**`;
              embedColor = 0x6B7280;
            }

            const statusEmbed = new EmbedBuilder()
              .setColor(embedColor)
              .setTitle(embedTitle)
              .setDescription(embedDesc)
              .setFooter({ text: 'Richman Estate' })
              .setTimestamp();

            await foundTicketChannel.send({ embeds: [statusEmbed], components }).catch(() => {});

            if (isClosed) {
              setTimeout(() => {
                foundTicketChannel.delete('Dossier clôturé depuis le panel admin').catch(() => {});
              }, 3000);
            }
          }

          // Sync vehicle or suite status in DB and Discord Showroom (rented if confirmed, confirmed/disponible if returned/cancelled)
          if (displayName) {
            const newStatus = isConfirmed ? 'rented' : 'confirmed';
            if (!isSuite) {
              const { data: vList } = await supabaseService.supabaseRequest(`vehicules?name=ilike.${encodeURIComponent(displayName)}&limit=1`);
              if (vList && vList.length > 0) {
                const targetVId = vList[0].id;
                await supabaseService.syncItemStatus('fleet', targetVId, newStatus).catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-fleet-vehicle-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ vehicleId: targetVId, status: newStatus })
                  }).catch(() => {});
                } catch (e) {}
              }
            } else {
              const { data: sList } = await supabaseService.supabaseRequest(`suites?name=ilike.${encodeURIComponent(displayName)}&limit=1`);
              if (sList && sList.length > 0) {
                const targetSId = sList[0].id;
                await supabaseService.syncItemStatus('suite', targetSId, newStatus).catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-hotel-suite-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ suiteId: targetSId, status: newStatus })
                  }).catch(() => {});
                } catch (e) {}
              }
            }
          }

          const shortRef = String(booking_id).slice(0, 6).toUpperCase();

          if (discord_id && config.isValidSnowflake(discord_id)) {
            try {
              const targetUser = await client.users.fetch(discord_id).catch(() => null);
              if (targetUser) {
                const photoUrl = isSuite ? null : resolveVehiclePhotoUrl(displayName);

                let dmTitle = '';
                let dmDesc = '';
                let dmColor = 0x10B981;

                if (isCompleted) {
                  dmTitle = isSuite ? '🏨 SÉJOUR CLÔTURÉ • MERCI DE VOTRE VISITE' : '🚗 RESTITUTION VALIDÉE • LOCATION TERMINÉE';
                  dmDesc = `Bonjour **${client_name || 'Citoyen'}**,\n\n` +
                    `La restitution pour **${luxuryTitle}** a été validée par notre équipe.\n\n` +
                    `🔖 **Référence Dossier :** \`#${shortRef}\`\n` +
                    `📄 **Facture & Reçu :** Votre reçu officiel reste disponible dans votre [Espace Client](${config.SITE_URL}/client.html).\n\n` +
                    `Toute l'équipe de Richman Estate vous remercie pour votre confiance !`;
                  dmColor = 0x10B981;
                } else if (isConfirmed) {
                  dmTitle = isSuite ? '🏨 RÉSERVATION CONFIRMÉE • RICHMAN ESTATE' : '🎉 LOCATION CONFIRMÉE • RICHMAN ESTATE';
                  dmDesc = `Bonjour **${client_name || 'Citoyen'}**,\n\n` +
                    `Votre demande de réservation pour **${luxuryTitle}** a été **VALIDÉE** !\n\n` +
                    `🔖 **Référence Dossier :** \`#${shortRef}\`\n` +
                    (isSuite 
                      ? `🔑 **Remise des clés :** Votre hébergement est prêt pour votre séjour.\n`
                      : `🔑 **Mise à disposition :** Votre véhicule est préparé et prêt pour la remise des clés.\n`
                    ) +
                    (foundTicketChannel ? `💬 **Salon d'échange dédié :** <#${foundTicketChannel.id}>\n` : '') +
                    `🌐 **Espace Client :** [Accéder à mon espace en ligne](${config.SITE_URL}/client.html)`;
                  dmColor = 0x10B981;
                } else if (isCancelled) {
                  dmTitle = '❌ DEMANDE NON RETENUE • RICHMAN ESTATE';
                  dmDesc = `Bonjour **${client_name || 'Citoyen'}**,\n\nVotre demande pour **${luxuryTitle}** n'a pas pu être retenue.\n\n🔖 **Référence :** \`#${shortRef}\``;
                  dmColor = 0xEF4444;
                }

                if (dmTitle) {
                  const dmEmbed = new EmbedBuilder()
                    .setColor(dmColor)
                    .setTitle(dmTitle)
                    .setDescription(dmDesc)
                    .setFooter({ text: 'Richman Estate' })
                    .setTimestamp();

                  const dmFiles = [];
                  if (photoUrl && String(photoUrl).startsWith('http')) {
                    try {
                      const ext = photoUrl.split('?')[0].split('.').pop() || 'webp';
                      const filename = `status_${shortRef || Date.now()}.${ext}`;
                      const attachment = new AttachmentBuilder(photoUrl, { name: filename });
                      dmEmbed.setImage(`attachment://${filename}`);
                      dmFiles.push(attachment);
                    } catch (e) {
                      dmEmbed.setImage(photoUrl);
                    }
                  }
                  await targetUser.send({ embeds: [dmEmbed], files: dmFiles }).catch(() => {});
                }
              }
            } catch (e) {}
          }

          let chatMessage = '';
          if (isConfirmed) {
            chatMessage = `✅ Votre réservation pour ${displayName} a été VALIDÉE.`;
          } else if (isCompleted) {
            chatMessage = `🔄 La restitution pour ${displayName} a été validée avec succès. Véhicule réintégré à la flotte.`;
          } else if (isClosed) {
            chatMessage = `🔒 Le dossier #${shortRef} a été clôturé et archivé.`;
          } else if (isCancelled) {
            chatMessage = `❌ Votre demande pour ${displayName} n'a pas été retenue.`;
          }

          if (chatMessage) {
            await supabaseService.addBookingMessage(
              booking_id,
              staff_name || 'Staff Richman',
              '',
              'staff',
              chatMessage
            );
          }

          return sendJSON(200, { success: true, channelFound: !!foundTicketChannel });
        } catch (err) {
          return sendError(500, 'Erreur mise à jour statut dossier', err.message);
        }
      }

      // 8. Sync Booking Message from Web to Discord Ticket
      if ((pathname === '/api/sync-booking-message' || pathname === '/api/send-booking-message' || pathname === '/api/booking-message') && req.method === 'POST') {
        const { booking_id, sender_name, message, content, discord_id, sender_role } = parsedBody;
        const finalContent = String(message || content || '').trim();

        if (!booking_id || !finalContent) {
          return sendError(400, 'booking_id et message (content) sont obligatoires');
        }

        const isStaffRole = (sender_role === 'staff' || sender_role === 'admin');
        const auth = await authenticateRequest(req);

        if (isStaffRole) {
          if (!auth.isStaff) {
            return sendError(403, 'Forbidden: Privilèges staff requis pour envoyer un message en tant que Staff');
          }
        } else if (auth.authType !== 'secret') {
          // Client : session obligatoire + vérification que le dossier appartient bien à l'appelant (anti-IDOR)
          if (!auth.isAuthenticated) {
            return sendError(401, 'Unauthorized: Session membre requise pour envoyer un message client');
          }

          let booking = null;
          try {
            const authHeader = req.headers['authorization'] ? { 'Authorization': req.headers['authorization'] } : {};
            const resp = await supabaseService.getBookingById(booking_id, authHeader);
            if (resp && Array.isArray(resp.data) && resp.data.length > 0) {
              booking = resp.data[0];
            }
          } catch (e) {}

          const callerDiscordId = resolveTokenDiscordId(auth);
          const callerFullName = (auth.profile && auth.profile.full_name) ||
                                 (auth.user && auth.user.user_metadata && (auth.user.user_metadata.full_name || auth.user.user_metadata.name || auth.user.user_metadata.custom_claims?.global_name)) ||
                                 null;
          const callerEmail = (auth.user && auth.user.email) || (auth.profile && auth.profile.email) || null;
          const callerUserId = (auth.user && auth.user.id) || null;

          if (!booking) {
            return sendError(403, 'Forbidden: Dossier introuvable ou vous n\'avez pas accès à cette réservation');
          }

          // SÉCURITÉ : suppression du matching par nom complet (homonymes + full_name
          // forgeable via user_metadata). Appartenance = user_id OU discord_id du
          // profil en base, aligné sur la RLS SQL.
          const discordMatches = Boolean(
            callerDiscordId && booking.discord_id && String(booking.discord_id).trim() === String(callerDiscordId).trim()
          );

          const userMatches = Boolean(
            callerUserId && booking.user_id && String(booking.user_id).trim() === String(callerUserId).trim()
          );

          const ownsBooking = auth.isStaff || discordMatches || userMatches;

          if (!ownsBooking) {
            return sendError(403, 'Forbidden: Vous ne pouvez écrire que dans vos propres dossiers de réservation');
          }
        }

        try {
          const role = isStaffRole ? 'staff' : 'client';
          const name = String(sender_name || (role === 'staff' ? 'Staff Richman' : 'Client Web')).slice(0, 50);

          // Si le client web ou l'admin a déjà inséré le message dans Supabase, skip_db_insert évite le doublon
          const shouldSkipDb = Boolean(parsedBody.skip_db_insert || parsedBody.skipDbInsert);
          if (!shouldSkipDb) {
            try {
              await supabaseService.addBookingMessage(booking_id, name, discord_id || null, role, finalContent);
            } catch (dbErr) {
              console.warn("⚠️ Erreur insertion DB addBookingMessage (continuation envoi Discord):", dbErr.message);
            }
          }

          let foundTicketChannel = null;
          const shortRef = String(booking_id).slice(0, 6).toLowerCase();

          for (const guild of client.guilds.cache.values()) {
            let ch = guild.channels.cache.find(c => c.isTextBased() && c.topic && c.topic.includes(`booking_id:${booking_id}`));
            if (!ch) {
              ch = guild.channels.cache.find(c => c.isTextBased() && (
                (c.name && c.name.includes(shortRef)) ||
                (c.topic && c.topic.includes(String(booking_id)))
              ));
            }
            if (ch) { foundTicketChannel = ch; break; }
          }

          if (foundTicketChannel) {
            const prefix = role === 'staff' ? '🖥️ **Staff (Admin Web)**' : '💻 **Client (Web)**';
            await foundTicketChannel.send(`${prefix} : ${finalContent.slice(0, 1800)}`).catch((err) => {
              console.warn("⚠️ Impossible d'envoyer le message dans le salon ticket Discord :", err.message);
            });
          }

          return sendJSON(200, { success: true, channelFound: !!foundTicketChannel });
        } catch (err) {
          return sendError(500, 'Erreur synchronisation message', err.message);
        }
      }

      // 8b. Get Direct Discord Channel URL for Ticket
      if (pathname === '/api/get-ticket-channel') {
        try {
          const booking_id = query.booking_id || (parsedBody && (parsedBody.booking_id || parsedBody.id));
          const discord_id = query.discord_id || (parsedBody && parsedBody.discord_id);
          const client_name = query.client_name || (parsedBody && parsedBody.client_name);

          const targetGuild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
          const targetGuildId = targetGuild ? targetGuild.id : '1537171063715401870';

          // 1. Check if Supabase booking already has ticket_channel_id
          if (booking_id) {
            try {
              const bData = await supabaseService.getBookingById(booking_id);
              if (bData && bData.ticket_channel_id) {
                return sendJSON(200, {
                  success: true,
                  channelId: bData.ticket_channel_id,
                  guildId: targetGuildId,
                  url: `https://discord.com/channels/${targetGuildId}/${bData.ticket_channel_id}`
                });
              }
            } catch (e) {}
          }

          const shortId = booking_id ? String(booking_id).slice(0, 6).toLowerCase() : '';
          const namePart = client_name ? String(client_name).split('|')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '') : '';

          let foundTicketChannel = null;

          for (const guild of client.guilds.cache.values()) {
            try {
              await guild.channels.fetch().catch(() => {});
            } catch (e) {}

            const allChannelsAndThreads = [
              ...guild.channels.cache.values(),
              ...((guild.threads && guild.threads.cache) ? guild.threads.cache.values() : [])
            ];

            // 1. Check by booking_id in topic
            if (booking_id) {
              const ch1 = allChannelsAndThreads.find(c => c && c.topic && (
                c.topic.includes(`booking_id:${booking_id}`) ||
                c.topic.includes(String(booking_id)) ||
                (shortId && c.topic.toLowerCase().includes(shortId))
              ));
              if (ch1) { foundTicketChannel = ch1; break; }
            }

            // 2. Check by channel name containing shortId (e.g. suite-172fff)
            if (!foundTicketChannel && shortId) {
              const ch2 = allChannelsAndThreads.find(c => c && c.name && c.name.toLowerCase().includes(shortId));
              if (ch2) { foundTicketChannel = ch2; break; }
            }

            // 3. Check by discord_id in topic
            if (!foundTicketChannel && discord_id) {
              const ch3 = allChannelsAndThreads.find(c => c && c.topic && (
                c.topic.includes(`discord_id:${discord_id}`) ||
                c.topic.includes(String(discord_id))
              ));
              if (ch3) { foundTicketChannel = ch3; break; }
            }

            // 4. Check by client name in channel name or topic
            if (!foundTicketChannel && namePart && namePart.length >= 3) {
              const ch4 = allChannelsAndThreads.find(c => c && (
                (c.name && c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(namePart)) ||
                (c.topic && c.topic.toLowerCase().replace(/[^a-z0-9]/g, '').includes(namePart))
              ));
              if (ch4) { foundTicketChannel = ch4; break; }
            }
          }

          if (foundTicketChannel) {
            // Save ticket_channel_id to Supabase
            if (booking_id) {
              supabaseService.supabaseRequest(`bookings?id=eq.${booking_id}`, 'PATCH', {
                ticket_channel_id: foundTicketChannel.id
              }).catch(() => {});
            }

            return sendJSON(200, {
              success: true,
              channelId: foundTicketChannel.id,
              channelName: foundTicketChannel.name,
              guildId: targetGuildId,
              url: `https://discord.com/channels/${targetGuildId}/${foundTicketChannel.id}`
            });
          }

          return sendJSON(200, {
            success: false,
            fallbackUrl: `https://discord.com/channels/${targetGuildId}`,
            message: 'Salon introuvable sur Discord'
          });
        } catch (err) {
          return sendError(500, 'Erreur recherche salon Discord', err.message);
        }
      }

      // 9. Close Ticket / Delete Booking Ticket
      if ((pathname === '/api/close-ticket' || pathname === '/api/delete-booking-ticket') && req.method === 'POST') {
        try {
          const booking_id = parsedBody.booking_id || parsedBody.bookingId || parsedBody.ticket_id || parsedBody.id;
          if (!booking_id) return sendError(400, 'booking_id requis');

          let foundTicketChannel = null;
          for (const guild of client.guilds.cache.values()) {
            const ch = guild.channels.cache.find(c => c.isTextBased() && c.topic && c.topic.includes(`booking_id:${booking_id}`));
            if (ch) { foundTicketChannel = ch; break; }
          }

          if (foundTicketChannel) {
            const closeEmbed = new EmbedBuilder()
              .setColor(0xEF4444)
              .setTitle('🔒 FERMETURE DU TICKET • PANEL WEB')
              .setDescription('Ce ticket a été clôturé depuis le panel web. Suppression en cours...')
              .setTimestamp();

            await foundTicketChannel.send({ embeds: [closeEmbed] }).catch(() => {});
            setTimeout(() => {
              foundTicketChannel.delete('Clôturé depuis le Panel Web').catch(() => {});
            }, 3000);
          }

          return sendJSON(200, { success: true, channelDeleted: !!foundTicketChannel });
        } catch (err) {
          return sendError(500, 'Erreur clôture ticket', err.message);
        }
      }

      // 10. Sync Fleet Channel
      if (pathname === '/api/sync-fleet-channel' && req.method === 'POST') {
        try {
          const channelId = config.CHANNEL_FLOTTE_FORUM_ID || config.CHANNEL_FLOTTE_DISPONIBLE || '1537811600822636584';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel) return sendError(404, 'Salon de la flotte introuvable');

          const resp = await supabaseService.supabaseRequest('vehicules?select=*&order=created_at.desc');
          const vehicles = Array.isArray(resp.data) ? resp.data : [];

          const isForum = channel.type === ChannelType.GuildForum;

          if (isForum) {
            try {
              await channel.setDefaultForumLayout(ForumLayoutType.GalleryView).catch(() => {});
            } catch (e) {}

            let availableTags = channel.availableTags || [];
            if (availableTags.length === 0) {
              try {
                await channel.setAvailableTags([
                  { name: '🟢 Disponible' },
                  { name: '🔴 En Location' },
                  { name: '⚡ Supercars' },
                  { name: '🏎️ Sportives' },
                  { name: '🏛️ Classiques' },
                  { name: '🚙 SUV & 4x4' },
                  { name: '💪 Muscle Cars' },
                  { name: '👑 Prestige' },
                  { name: '🚗 Voitures' },
                  { name: '🏍️ Motos' },
                  { name: '🛥️ Bateaux' },
                  { name: '🚁 Hélicoptères' },
                  { name: '✈️ Avions' }
                ]);
                const refetched = await client.channels.fetch(channelId);
                availableTags = refetched.availableTags || [];
              } catch (tagErr) {
                console.warn("Could not set forum tags:", tagErr.message);
              }
            }

            // Clean existing threads
            try {
              const allThreads = await fetchAllForumThreads(channel);
              for (const t of allThreads) {
                await t.delete().catch(() => {});
              }
            } catch (cleanErr) {
              console.warn("Clean forum threads warning:", cleanErr.message);
            }

            // Create thread per vehicle
            for (const item of vehicles) {
              const isAvailable = item.status === 'confirmed';
              const { embed: vEmbed, row: vRow, luxuryTitle } = buildVehicleShowroom(item, isAvailable);
              const threadTitle = `🏎️ ${luxuryTitle.toUpperCase()}`.slice(0, 100);
              const appliedTags = getForumTagIds(availableTags, isAvailable, undefined, item.specs, item.name);

              try {
                await channel.threads.create({
                  name: threadTitle,
                  message: { embeds: [vEmbed], components: [vRow] },
                  appliedTags: appliedTags
                });
              } catch (createErr) {
                console.error(`Erreur création thread forum pour ${item.name}:`, createErr.message);
              }

              await new Promise(r => setTimeout(r, 350));
            }
          }

          return sendJSON(200, { success: true, count: vehicles.length, isForum });
        } catch (err) {
          return sendError(500, 'Erreur synchronisation flotte', err.message);
        }
      }

      // 11. Update Fleet Vehicle Status
      if (pathname === '/api/update-fleet-vehicle-status' && req.method === 'POST') {
        try {
          const { vehicleId, status } = parsedBody;
          if (!vehicleId) return sendError(400, 'vehicleId requis');

          const channelId = config.CHANNEL_FLOTTE_FORUM_ID || config.CHANNEL_FLOTTE_DISPONIBLE || '1537811600822636584';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel) return sendError(404, 'Salon de la flotte introuvable');

          const resp = await supabaseService.supabaseRequest(`vehicules?id=eq.${vehicleId}&select=*`);
          const list = Array.isArray(resp.data) ? resp.data : [];
          const item = list[0];
          if (!item) return sendError(404, 'Véhicule introuvable en base');

          const isAvailable = status
            ? (status === 'confirmed' || status === 'available')
            : (item.status === 'confirmed' || item.status === 'available');
          const targetIdTag = `#${vehicleId.slice(0, 8).toUpperCase()}`;

          // Keep DB status aligned
          const targetDbStatus = isAvailable ? 'confirmed' : 'rented';
          if (item.status !== targetDbStatus) {
            await supabaseService.syncItemStatus('fleet', vehicleId, targetDbStatus).catch(() => {});
          }

          const { embed: vEmbed, row: vRow, luxuryTitle } = buildVehicleShowroom(item, isAvailable);
          const isForum = channel.type === ChannelType.GuildForum;

          if (isForum) {
            const availableTags = channel.availableTags || [];
            const tagIds = getForumTagIds(availableTags, isAvailable, undefined, item.specs, item.name);

            const targetThread = await findThreadByTarget(channel, targetIdTag);

            if (targetThread) {
              if (targetThread.archived) await targetThread.setArchived(false).catch(() => {});
              if (tagIds.length > 0) await targetThread.setAppliedTags(tagIds).catch(() => {});
              const starter = await targetThread.fetchStarterMessage().catch(() => null);
              if (starter) {
                await starter.edit({ embeds: [vEmbed], components: [vRow] }).catch(() => {});
              }
            } else {
              const threadTitle = `🏎️ ${luxuryTitle.toUpperCase()}`.slice(0, 100);
              await channel.threads.create({
                name: threadTitle,
                message: { embeds: [vEmbed], components: [vRow] },
                appliedTags: tagIds
              }).catch(() => {});
            }
            updateBotPresence(client).catch(() => {});
          }

          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur mise à jour statut véhicule', err.message);
        }
      }

      // 12. Delete Fleet Vehicle Message
      if (pathname === '/api/delete-fleet-vehicle-message' && req.method === 'POST') {
        try {
          const { vehicleId } = parsedBody;
          if (!vehicleId) return sendError(400, 'vehicleId requis');

          const channelId = config.CHANNEL_FLOTTE_FORUM_ID || config.CHANNEL_FLOTTE_DISPONIBLE || '1537811600822636584';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel && channel.type === ChannelType.GuildForum) {
            await deleteThreadsByTarget(channel, `#${vehicleId.slice(0, 8).toUpperCase()}`);
          }

          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur suppression message flotte', err.message);
        }
      }

      // 12a. Sync Discord Hotel & Suites Forum Showroom
      if (pathname === '/api/sync-discord-suites' && req.method === 'POST') {
        try {
          const channelId = config.CHANNEL_HOTEL_FORUM_ID || '1538264863338528849';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel) return sendError(404, 'Salon Forum Hôtel introuvable');

          const resp = await supabaseService.supabaseRequest('suites?select=*&order=created_at.desc');
          const suites = Array.isArray(resp.data) ? resp.data : [];

          const isForum = channel.type === ChannelType.GuildForum;
          if (isForum) {
            let availableTags = channel.availableTags || [];
            if (channel.setAvailableTags && (!availableTags || availableTags.length === 0)) {
              try {
                await channel.setAvailableTags([
                  { name: '🟢 Disponible', moderated: false },
                  { name: '🔴 Occupée', moderated: false },
                  { name: '🏰 Villa', moderated: false },
                  { name: '🌆 Penthouse', moderated: false },
                  { name: '🏨 Suite', moderated: false }
                ]).catch(() => {});
                const updatedCh = await client.channels.fetch(channelId).catch(() => null);
                if (updatedCh && updatedCh.availableTags) availableTags = updatedCh.availableTags;
              } catch (e) {}
            }

            // Clean existing threads
            try {
              const allThreads = await fetchAllForumThreads(channel);
              for (const t of allThreads) {
                await t.delete().catch(() => {});
              }
            } catch (cleanErr) {}

            // Create thread per suite
            for (const item of suites) {
              const isAvailable = (item.status === 'confirmed' || item.status === 'available');
              const { embed: sEmbed, row: sRow, files: sFiles, suiteTitle } = await buildSuiteShowroom(item, isAvailable);
              const threadTitle = `🏨 ${suiteTitle.toUpperCase()}`.slice(0, 100);
              const appliedTags = getSuiteForumTagIds(availableTags, isAvailable, item.name, item.specs);

              try {
                await channel.threads.create({
                  name: threadTitle,
                  message: { embeds: [sEmbed], files: sFiles || [], components: [sRow] },
                  appliedTags: appliedTags
                });
              } catch (createErr) {
                console.error(`Erreur création thread suite ${item.name}:`, createErr.message);
              }

              await new Promise(r => setTimeout(r, 350));
            }
          }

          updateBotPresence(client).catch(() => {});
          return sendJSON(200, { success: true, count: suites.length, isForum });
        } catch (err) {
          return sendError(500, 'Erreur synchronisation suites hôtel', err.message);
        }
      }

      // 12b. Update Hotel Suite Status
      if (pathname === '/api/update-hotel-suite-status' && req.method === 'POST') {
        try {
          const { suiteId, status } = parsedBody;
          if (!suiteId) return sendError(400, 'suiteId requis');

          const channelId = config.CHANNEL_HOTEL_FORUM_ID || '1538264863338528849';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel) return sendError(404, 'Salon Forum Hôtel introuvable');

          const resp = await supabaseService.supabaseRequest(`suites?id=eq.${suiteId}&select=*`);
          const list = Array.isArray(resp.data) ? resp.data : [];
          const item = list[0];
          if (!item) return sendError(404, 'Suite introuvable en base');

          const isAvailable = status
            ? (status === 'confirmed' || status === 'available')
            : (item.status === 'confirmed' || item.status === 'available');
          const targetIdTag = `#${suiteId.slice(0, 8).toUpperCase()}`;

          // Keep DB status aligned
          const targetDbStatus = isAvailable ? 'confirmed' : 'rented';
          if (item.status !== targetDbStatus) {
            await supabaseService.syncItemStatus('suite', suiteId, targetDbStatus).catch(() => {});
          }

          const { embed: sEmbed, row: sRow, files: sFiles, suiteTitle } = await buildSuiteShowroom(item, isAvailable);

          const isForum = channel.type === ChannelType.GuildForum;
          if (isForum) {
            const availableTags = channel.availableTags || [];
            const tagIds = getSuiteForumTagIds(availableTags, isAvailable, item.name, item.specs);

            const targetThread = await findThreadByTarget(channel, targetIdTag);

            if (targetThread) {
              if (targetThread.archived) await targetThread.setArchived(false).catch(() => {});
              if (tagIds.length > 0) await targetThread.setAppliedTags(tagIds).catch(() => {});
              const starter = await targetThread.fetchStarterMessage().catch(() => null);
              if (starter) {
                await starter.edit({ embeds: [sEmbed], files: sFiles || [], components: [sRow] }).catch(() => {});
              }
            } else {
              const threadTitle = `🏨 ${suiteTitle.toUpperCase()}`.slice(0, 100);
              await channel.threads.create({
                name: threadTitle,
                message: { embeds: [sEmbed], files: sFiles || [], components: [sRow] },
                appliedTags: tagIds
              }).catch(() => {});
            }
            updateBotPresence(client).catch(() => {});
          }

          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur mise à jour statut suite', err.message);
        }
      }

      // 12c. Delete Hotel Suite Message
      if (pathname === '/api/delete-hotel-suite-message' && req.method === 'POST') {
        try {
          const { suiteId } = parsedBody;
          if (!suiteId) return sendError(400, 'suiteId requis');

          const channelId = config.CHANNEL_HOTEL_FORUM_ID || '1538264863338528849';
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel && channel.type === ChannelType.GuildForum) {
            await deleteThreadsByTarget(channel, `#${suiteId.slice(0, 8).toUpperCase()}`);
          }

          return sendJSON(200, { success: true });
        } catch (err) {
          return sendError(500, 'Erreur suppression message suite', err.message);
        }
      }

      // 13. Manage User Roles on Discord (Add / Remove)
      if (pathname === '/api/manage-user-roles' && req.method === 'POST') {
        try {
          const { discordId, action, roleKey, roleId } = parsedBody;
          if (!discordId || !config.isValidSnowflake(discordId)) {
            return sendError(400, 'discordId valide requis');
          }

          const guild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
          if (!guild) return sendError(503, 'Serveur Discord introuvable');

          const member = await guild.members.fetch(discordId).catch(() => null);
          if (!member) return sendError(404, 'Membre introuvable sur le serveur Discord');

          const ROLE_MAP = {
            owner: config.ROLE_OWNER_ID,
            admin: config.ROLE_ADMIN_ID,
            gerant_hotel: config.ROLE_GERANT_HOTEL_ID,
            gerant_vehicules: config.ROLE_GERANT_VEHICULES_ID,
            vip: config.ROLE_VIP_ID,
            citoyen: config.ROLE_CITOYEN_ID,
            membre: config.ROLE_MEMBRE_ID
          };

          let targetRole = null;
          if (roleId && guild.roles.cache.has(roleId)) {
            targetRole = guild.roles.cache.get(roleId);
          } else if (roleKey) {
            const mappedId = ROLE_MAP[roleKey];
            if (mappedId && guild.roles.cache.has(mappedId)) {
              targetRole = guild.roles.cache.get(mappedId);
            } else {
              const kwMap = {
                owner: ['fondateur', 'owner', 'direction'],
                admin: ['admin', 'administrateur', 'staff'],
                gerant_hotel: ['gérant hôtel', 'gerant hotel', 'hotel', 'hôtel'],
                gerant_vehicules: ['gérant véhicules', 'gerant vehicules', 'gérant véhicule', 'gerant vehicule', 'gérant voiture', 'gerant voiture', 'gérant voitures', 'gerant voitures', 'voiture', 'flotte', 'concession'],
                vip: ['vip'],
                citoyen: ['citoyen', 'enregistré', 'membre']
              };
              const kws = kwMap[roleKey] || [roleKey];
              targetRole = guild.roles.cache.find(r => kws.some(k => r.name.toLowerCase().includes(k)));
            }

            // Auto-create role on Discord if not found when adding
            if (!targetRole && action === 'add') {
              try {
                if (roleKey === 'gerant_vehicules') {
                  targetRole = await guild.roles.create({
                    name: '🚗 Gérant Véhicules',
                    color: 0x3B82F6,
                    reason: 'Création automatique rôle Gérant Véhicules par Richman Estate'
                  });
                } else if (roleKey === 'gerant_hotel') {
                  targetRole = await guild.roles.create({
                    name: '🏨 Gérant Hôtel',
                    color: 0x8B5CF6,
                    reason: 'Création automatique rôle Gérant Hôtel par Richman Estate'
                  });
                }
              } catch (createErr) {
                console.warn('[Auto-create role error]:', createErr.message);
              }
            }
          }

          if (!targetRole) {
            return sendError(404, `Rôle introuvable sur le serveur Discord.`);
          }

          // --- ANTI-ESCALADE : hiérarchie stricte des rôles Discord ---
          // Un staff ne gère que des rôles STRICTEMENT inférieurs au sien (niveau égal
          // interdit sauf pour l'owner), et un rôle libre (roleId hors whitelist) est
          // traité comme un rôle d'administration (réservé owner). La clé secrète
          // (authType 'secret') contourne ces limites par conception.
          const callerAuth = req.auth || await authenticateRequest(req);
          const callerRole = (callerAuth.profile && callerAuth.profile.role) || null;
          const isSecretAuth = callerAuth.authType === 'secret';
          const ROLE_LEVEL = { owner: 4, admin: 3, gerant_hotel: 2, gerant_vehicules: 2, vip: 1, citoyen: 0, membre: 0 };
          const callerLevel = isSecretAuth ? 5 : (ROLE_LEVEL[callerRole] !== undefined ? ROLE_LEVEL[callerRole] : 0);

          let targetLevel = null;
          if (roleKey && ROLE_LEVEL[roleKey] !== undefined) {
            targetLevel = ROLE_LEVEL[roleKey];
          } else {
            let targetKey = null;
            for (const [k, id] of Object.entries(ROLE_MAP)) {
              if (id && targetRole.id === id) { targetKey = k; break; }
            }
            targetLevel = targetKey !== null ? (ROLE_LEVEL[targetKey] !== undefined ? ROLE_LEVEL[targetKey] : 1) : 3;
          }

          if (targetLevel > callerLevel || (targetLevel === callerLevel && callerLevel < 4)) {
            return sendError(403, `Action refusée : vous ne pouvez pas gérer un rôle de niveau supérieur ou égal au vôtre (« ${targetRole.name} »).`);
          }

          if (guild.members.me && guild.members.me.roles.highest.position <= targetRole.position) {
            return sendError(403, `Le rôle du bot n'est pas assez haut dans la hiérarchie Discord pour gérer le rôle "${targetRole.name}".`);
          }

          if (action === 'add') {
            await member.roles.add(targetRole);
          } else if (action === 'remove') {
            await member.roles.remove(targetRole);
          } else {
            return sendError(400, 'Action invalide (doit être "add" ou "remove")');
          }

          const updatedRoles = [...member.roles.cache.values()]
            .filter(r => r.name !== '@everyone')
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor }));

          return sendJSON(200, {
            success: true,
            action,
            roleName: targetRole.name,
            roleId: targetRole.id,
            roles: updatedRoles
          });
        } catch (err) {
          return sendError(500, 'Erreur modification rôle Discord', err.message);
        }
      }

      // 404 Not Found
      return sendError(404, `Endpoint non trouvé : ${pathname}`);
    });
  });

  const activePort = customPort || (process.env.PORT ? parseInt(process.env.PORT, 10) : config.PORT);
  // Local : confinement sur 127.0.0.1. Hébergement (Render & co) : écoute sur toutes
  // les interfaces, sinon le service n'est pas joignable — détecté via RENDER ou BOT_API_HOST.
  const apiHost = process.env.BOT_API_HOST
    || ((process.env.RENDER === 'true' || process.env.RENDER === '1') ? '0.0.0.0' : '127.0.0.1');
  server.listen(activePort, apiHost, () => {
    console.log(`🤖 REST API Bot Richman active et sécurisée sur http://${apiHost}:${activePort}`);
  });

  return server;
}

module.exports = { startApiServer, formatLuxuryCarName, resolveVehiclePhotoUrl };
