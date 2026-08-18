/**
 * Richman Discord Bot — Constants, Configuration & Security Helpers
 */
const path = require('path');
const crypto = require('crypto');
const { PermissionFlagsBits } = require('discord.js');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const config = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID || '1537171063715401870',
  ROLE_MEMBRE_ID: process.env.ROLE_MEMBRE_ID,
  ROLE_CITOYEN_ID: process.env.ROLE_CITOYEN_ID,
  ROLE_STAFF_ID: process.env.ROLE_STAFF_ID || process.env.ROLE_ADMIN_ID || '1537194551813603338',
  ROLE_OWNER_ID: process.env.ROLE_OWNER_ID,
  ROLE_ADMIN_ID: process.env.ROLE_ADMIN_ID,
  ROLE_GERANT_HOTEL_ID: process.env.ROLE_GERANT_HOTEL_ID,
  ROLE_GERANT_VEHICULES_ID: process.env.ROLE_GERANT_VEHICULES_ID || '1537194801512980561',
  ROLE_VIP_ID: process.env.ROLE_VIP_ID,
  ROLE_DIAMOND_VIP_ID: process.env.ROLE_DIAMOND_VIP_ID,
  ROLE_CONCIERGE_ID: process.env.ROLE_CONCIERGE_ID,
  ROLE_PARTENAIRE_ID: process.env.ROLE_PARTENAIRE_ID,
  MASTER_OWNER_ID: process.env.MASTER_OWNER_ID || '985083967642423366',
  SITE_URL: (process.env.SITE_URL || 'https://richman-estate.vercel.app').replace(/\/+$/, ''),
  
  CAT_TICKETS_LOCATIONS_ID: process.env.CAT_TICKETS_LOCATIONS_ID || process.env.CAT_TICKETS_CARS_ID || '1537552582418104462',
  CAT_TICKETS_SUITES_ID: process.env.CAT_TICKETS_SUITES_ID || '1537780514453463152',
  CAT_TICKETS_CONTACT_ID: process.env.CAT_TICKETS_CONTACT_ID || '1537808868636238024',
  
  CHANNEL_FLOTTE_FORUM_ID: process.env.CHANNEL_FLOTTE_FORUM_ID || process.env.CHANNEL_FLOTTE_DISPONIBLE || '1537811600822636584',
  CHANNEL_HOTEL_FORUM_ID: process.env.CHANNEL_HOTEL_FORUM_ID || process.env.CHANNEL_SUITES_FORUM_ID || '1538264863338528849',
  CHANNEL_ADMIN_LOGS: process.env.CHANNEL_ADMIN_LOGS || '1537194557199097866',
  CHANNEL_RESERVATIONS_HOTEL: process.env.CHANNEL_HOTEL_FORUM_ID || process.env.CHANNEL_RESERVATIONS_HOTEL || '1538264863338528849',
  CHANNEL_DEMANDES_LOCATIONS: process.env.CHANNEL_DEMANDES_LOCATIONS || '1537197295123173469',
  REGLEMENT_CHANNEL_ID: process.env.REGLEMENT_CHANNEL_ID,
  ENREGISTREMENT_CHANNEL_ID: process.env.ENREGISTREMENT_CHANNEL_ID,
  WELCOME_CHANNEL_ID: process.env.WELCOME_CHANNEL_ID,
  
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://ghbeopdnfdxuqfjzmmeb.supabase.co',
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_U5u4jQKVTgWkhmzM62ficA_wORi3zOq',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null,
  API_SECRET: process.env.BOT_API_SECRET,
  PORT: parseInt(process.env.PORT, 10) || 3001,
  MAX_PAYLOAD_SIZE: 1024 * 1024 // 1 MB
};

// Sécurité : si la clé service est absente, le bot retombe silencieusement sur la
// clé anon (écritures RLS refusées, RPC du chat bloquées) — alerter immédiatement.
if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY absente : le bot utilisera la clé anon (écritures RLS et chat refusés). Configurez la clé service dans bot/.env.');
}

/**
 * Constant-time string comparison to prevent side-channel timing attacks on API secrets
 */
function validateApiSecret(authHeader, expectedSecret) {
  if (!expectedSecret) return false;
  if (!authHeader || typeof authHeader !== 'string') return false;

  let providedToken = authHeader.trim();
  if (providedToken.startsWith('Bearer ')) {
    providedToken = providedToken.slice(7).trim();
  }

  if (providedToken.length !== expectedSecret.length) return false;

  try {
    const bufA = Buffer.from(providedToken, 'utf8');
    const bufB = Buffer.from(expectedSecret, 'utf8');
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

const MASTER_OWNERS = ['985083967642423366', '1015310406169923665'];

/**
 * Comprehensive Staff Privilege Verification
 */
function isStaffMember(member) {
  if (!member) return false;
  const userId = String(member.id || member.user?.id || '').trim();
  if (MASTER_OWNERS.includes(userId)) return true;
  if (config.MASTER_OWNER_ID && userId === String(config.MASTER_OWNER_ID).trim()) return true;
  if (member.guild && member.guild.ownerId === userId) return true;

  if (member.permissions && typeof member.permissions.has === 'function' && (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers)
  )) {
    return true;
  }

  const staffRoleIds = [
    config.ROLE_OWNER_ID,
    config.ROLE_ADMIN_ID,
    config.ROLE_STAFF_ID,
    config.ROLE_GERANT_HOTEL_ID,
    config.ROLE_GERANT_VEHICULES_ID,
    config.ROLE_CONCIERGE_ID,
    '1537194551813603338',
    '1537194801512980561',
    '1537194801512980560'
  ].filter(Boolean);

  if (member.roles && member.roles.cache) {
    if (member.roles.cache.some(r => 
      staffRoleIds.includes(r.id) ||
      r.name.toLowerCase().includes('gérant') ||
      r.name.toLowerCase().includes('gerant') ||
      r.name.toLowerCase().includes('admin') ||
      r.name.toLowerCase().includes('fondateur')
    )) return true;
  }

  return false;
}

/**
 * Sanitize strings for Discord channel topics (prevent metadata injection)
 */
function sanitizeTopicValue(val) {
  if (val == null) return '';
  return String(val).replace(/[|\r\n:]/g, ' ').trim();
}

/**
 * Validate Snowflake ID format
 */
function isValidSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id.trim());
}

module.exports = {
  ...config,
  validateApiSecret,
  isStaffMember,
  sanitizeTopicValue,
  isValidSnowflake
};
