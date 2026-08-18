/**
 * Richman Discord Bot — Event: ClientReady
 */
const { ActivityType } = require('discord.js');
const slashCommands = require('../commands/slashCommands');
const config = require('../config/constants');
const supabase = require('../services/supabase');
const { checkOverdueRentals } = require('../services/overdueChecker');

async function updateBotPresence(client) {
  if (!client || !client.user) return;
  try {
    const [vRes, sRes] = await Promise.all([
      supabase.getVehiculesCount(),
      supabase.getSuitesCount()
    ]);

    const vList = Array.isArray(vRes.data) ? vRes.data : [];
    const sList = Array.isArray(sRes.data) ? sRes.data : [];

    // Count strictly available items (confirmed in DB = available)
    const vehiculesCount = vList.filter(v => v.status === 'confirmed' || v.status === 'available').length;
    const suitesCount = sList.filter(s => s.status === 'confirmed' || s.status === 'available').length;

    const activityText = `Dispo : 🚗 ${vehiculesCount} Voitures • 🏨 ${suitesCount} Suites`;

    client.user.setPresence({
      activities: [{ name: activityText, type: ActivityType.Watching }],
      status: 'online'
    });
    console.log(`📡 Statut bot actualisé en direct : "Regarde ${activityText}"`);
  } catch (err) {
    console.error('⚠️ Erreur mise à jour présence bot :', err.message);
    client.user.setPresence({
      activities: [{ name: 'Dispo : 🚗 21 Voitures • 🏨 2 Suites', type: ActivityType.Watching }],
      status: 'online'
    });
  }
}

module.exports = {
  name: 'ready',
  once: true,
  updateBotPresence,
  async execute(client) {
    console.log(`====================================================`);
    console.log(`🤖 Richman Estate Bot connecté avec succès !`);
    console.log(`Logged as: ${client.user.tag}`);

    // Update presence dynamically on launch
    await updateBotPresence(client);

    // Refresh presence every 45 seconds to keep stock counters updated in real-time
    setInterval(() => {
      updateBotPresence(client);
    }, 45000);

    // Check overdue rentals on launch and every 3 minutes
    setTimeout(() => checkOverdueRentals(client), 5000);
    setInterval(() => {
      checkOverdueRentals(client);
    }, 3 * 60 * 1000);

    // Création / Vérification automatique du rôle "🌲 Citoyen"
    client.guilds.cache.forEach(async (guild) => {
      let citoyenRole = guild.roles.cache.find(r => r.name.includes('Citoyen') || r.name.includes('Enregistré'));
      if (!citoyenRole) {
        try {
          citoyenRole = await guild.roles.create({
            name: '🌲 Citoyen',
            color: '#10b981',
            reason: 'Rôle automatique attribué lors de la validation de l\'enregistrement'
          });
          console.log(`🎉 Rôle "${citoyenRole.name}" créé avec succès ! ID: ${citoyenRole.id}`);
        } catch (e) {
          console.error("Erreur lors de la création du rôle :", e.message);
        }
      } else {
        console.log(`✅ Rôle de validation prêt : "${citoyenRole.name}" | ID: ${citoyenRole.id}`);
      }
    });

    console.log(`====================================================`);

    // Enregistrement des commandes slash
    try {
      await slashCommands.registerSlashCommands();
    } catch (err) {
      console.error("❌ Erreur enregistrement slash commands :", err.message);
    }
  }
};
