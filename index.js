/**
 * ============================================================================
 * RICHMAN ESTATE DISCORD BOT — CORE ENTRYPOINT
 * ============================================================================
 * Architecture modulaire épurée et sécurisée.
 * Découpage : config/ | services/ | handlers/ | events/ | commands/
 * ============================================================================
 */
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
    api: 'https://canary.discord.com/api'
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

// Enregistrement dynamique des écouteurs d'événements
client.once(readyEvent.name, (...args) => readyEvent.execute(client, ...args));
client.on(interactionCreateEvent.name, (...args) => interactionCreateEvent.execute(client, ...args));
client.on(messageCreateEvent.name, (...args) => messageCreateEvent.execute(client, ...args));
client.on(guildMemberAddEvent.name, (...args) => guildMemberAddEvent.execute(client, ...args));
client.on(channelDeleteEvent.name, (...args) => channelDeleteEvent.execute(client, ...args));

// Démarrage du serveur REST API (port 3001) pour la communication Web <-> Discord
let apiServer = null;
try {
  apiServer = startApiServer(client);
} catch (err) {
  console.error("❌ Erreur initialisation Serveur API REST :", err.message);
}

// Connexion du bot à Discord
if (!config.TOKEN) {
  console.error("❌ DISCORD_TOKEN manquant dans le fichier .env !");
  process.exit(1);
}

client.login(config.TOKEN).catch(err => {
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
