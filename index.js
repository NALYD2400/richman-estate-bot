/**
 * ============================================================================
 * RICHMAN ESTATE DISCORD BOT — CORE ENTRYPOINT
 * ============================================================================
 * Architecture modulaire épurée et sécurisée.
 * Découpage : config/ | services/ | handlers/ | events/ | commands/
 * ============================================================================
 */
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}


const { 
  Client, 
  GatewayIntentBits, 
  Partials 
} = require('discord.js');

const config = require('./config/constants');
const { startApiServer } = require('./services/apiServer');

// Events
const readyEvent = require('./events/ready');
const interactionCreateEvent = require('./events/interactionCreate');
const messageCreateEvent = require('./events/messageCreate');
const guildMemberAddEvent = require('./events/guildMemberAdd');
const channelDeleteEvent = require('./events/channelDelete');

// Initialisation du client Discord avec les intents requis
const client = new Client({
  rest: {
    timeout: 20000,
    retries: 3
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember,
    Partials.Reaction
  ]
});

const { Events, REST, Routes } = require('discord.js');

// Enregistrement dynamique des écouteurs d'événements
client.once(Events.ClientReady, (...args) => readyEvent.execute(client, ...args));
client.on(interactionCreateEvent.name, (...args) => interactionCreateEvent.execute(client, ...args));
client.on(messageCreateEvent.name, (...args) => messageCreateEvent.execute(client, ...args));
client.on(guildMemberAddEvent.name, (...args) => guildMemberAddEvent.execute(client, ...args));
client.on(channelDeleteEvent.name, (...args) => channelDeleteEvent.execute(client, ...args));

client.on('debug', info => console.log('🔍 [Discord Debug]:', info));
client.on('error', error => console.error('❌ [Discord Client Error]:', error.message || error));
client.on('shardError', (error, shardId) => console.error(`❌ [Shard ${shardId} Error]:`, error.message || error));
client.on('shardDisconnect', (event, shardId) => console.warn(`⚠️ [Shard ${shardId} Disconnected]: Code ${event.code}`));
client.on('shardReconnecting', shardId => console.log(`🔄 [Shard ${shardId}] Reconnexion en cours...`));
client.on('shardResume', (shardId, replayedEvents) => console.log(`✅ [Shard ${shardId}] Reprise réussie (${replayedEvents} événements)`));

// Démarrage du serveur REST API (port 3001) pour la communication Web <-> Discord
let apiServer = null;
try {
  apiServer = startApiServer(client);
} catch (err) {
  console.error("❌ Erreur initialisation Serveur API REST :", err.message);
}

// Connexion du bot à Discord
const cleanToken = (config.TOKEN || '').trim();
if (!cleanToken) {
  console.error("❌ DISCORD_TOKEN manquant dans la configuration !");
  process.exit(1);
}

const https = require('https');
const nativeReq = https.get('https://discord.com/api/v10/gateway/bot', {
  headers: {
    'Authorization': `Bot ${cleanToken}`,
    'User-Agent': 'DiscordBot (https://richman-estate.vercel.app, 2.0.0)'
  }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log('📡 [Native HTTPS] Gateway Bot Status:', res.statusCode, d));
});
nativeReq.on('error', e => console.error('❌ [Native HTTPS] Error:', e.message));

client.login(cleanToken)
  .then(() => {
    console.log("✅ client.login() résolu avec succès");
  })
  .catch(err => {
    console.error("❌ Échec de connexion du bot Discord :", err.message);
  });

// Gestion des erreurs globales non interceptées
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Rejet de promesse non géré :', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Exception non interceptée :', err);
});

module.exports = { client, apiServer };
