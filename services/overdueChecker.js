/**
 * Richman Discord Bot — Automated Overdue & Return Reminder Service
 * Scans active confirmed rentals and pings staff & clients when the rental period expires.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const supabaseService = require('./supabase');
const config = require('../config/constants');
const { formatLuxuryCarName } = require('./vehicleUtils');

const alertedBookings = new Map(); // booking_id -> timestamp of last alert

async function checkOverdueRentals(client) {
  if (!client || !client.isReady()) return;

  try {
    const { data: activeBookings } = await supabaseService.supabaseRequest(
      'bookings?status=eq.confirmed&select=*'
    );

    if (!activeBookings || !Array.isArray(activeBookings) || activeBookings.length === 0) {
      return;
    }

    const now = Date.now();

    for (const b of activeBookings) {
      const isSuite = b.type === 'suite';
      const durationNum = parseInt(String(b.duration || '1'), 10) || 1;
      const durationUnit = isSuite ? (durationNum > 1 ? 'nuits' : 'nuit') : (durationNum > 1 ? 'jours' : 'jour');
      
      // Calculate expiration time (created_at + duration in days/nights)
      const startDate = b.created_at ? new Date(b.created_at).getTime() : now;
      const durationMs = durationNum * 24 * 60 * 60 * 1000;
      const expiresAt = startDate + durationMs;

      // If expired and not alerted in the past 6 hours
      if (now >= expiresAt) {
        const lastAlert = alertedBookings.get(b.id) || 0;
        if (now - lastAlert < 6 * 60 * 60 * 1000) {
          continue; // Already alerted recently
        }

        alertedBookings.set(b.id, now);
        const luxuryTitle = isSuite ? b.item_name : formatLuxuryCarName(b.item_name);
        const shortRef = String(b.id).slice(0, 6).toUpperCase();

        // 1. Find ticket channel in Discord
        let foundChannel = null;
        for (const guild of client.guilds.cache.values()) {
          const ch = guild.channels.cache.find(c => c.isTextBased() && c.topic && c.topic.includes(`booking_id:${b.id}`));
          if (ch) { foundChannel = ch; break; }
        }

        if (foundChannel) {
          const alertEmbed = new EmbedBuilder()
            .setColor(0xF59E0B)
            .setTitle(isSuite ? '⏰ ÉCHÉANCE DE SÉJOUR ATTEINTE • CHECK-OUT ATTENDU' : '⏰ ÉCHÉANCE DE LOCATION ATTEINTE • RESTITUTION DU VÉHICULE')
            .setDescription(
              `La période contractuelle de **${durationNum} ${durationUnit}** pour **${luxuryTitle}** est arrivée à son terme.\n\n` +
              `👤 **Client :** ${b.discord_id ? `<@${b.discord_id}>` : `**${b.client_name}**`}\n` +
              `🔖 **Référence Dossier :** \`#${shortRef}\`\n\n` +
              (isSuite
                ? `🔑 **Action requise :** Veuillez procéder à la remise des clés et à l'état des lieux de départ.`
                : `🚗 **Action requise :** Veuillez convenir du point de rendez-vous pour la restitution et l'inspection de la supercar.`
              ) +
              `\n\nUne fois la restitution effectuée, le staff peut valider la clôture du dossier ci-dessous.`
            )
            .setFooter({ text: 'Richman Estate • Système de Rappel Automatique' })
            .setTimestamp();

          const invoiceUrl = `${config.SITE_URL}/client.html?invoice=${b.id}`;
          const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`btn_ticket_return_${b.id}`)
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

          const pingContent = `🔔 ${config.ROLE_STAFF_ID ? `<@&${config.ROLE_STAFF_ID}>` : ''} ${b.discord_id ? `<@${b.discord_id}>` : ''} Échéance atteinte pour le dossier **#${shortRef}** (${luxuryTitle}) !`;
          await foundChannel.send({ content: pingContent, embeds: [alertEmbed], components: [actionRow] }).catch(() => {});
        }

        // 2. Add system note into Supabase chat
        await supabaseService.addBookingMessage(
          b.id,
          'Système Richman',
          client.user.id,
          'system',
          `⏰ Échéance atteinte : La période de location (${durationNum} ${durationUnit}) pour ${luxuryTitle} est terminée. Restitution en attente.`
        ).catch(() => {});

        // 3. Send Courteous DM to Client
        if (b.discord_id && config.isValidSnowflake(b.discord_id)) {
          try {
            const user = await client.users.fetch(b.discord_id).catch(() => null);
            if (user) {
              const dmEmbed = new EmbedBuilder()
                .setColor(0xF59E0B)
                .setTitle(isSuite ? '⏰ RAPPEL DE DÉPART • RICHMAN ESTATE' : '⏰ RAPPEL DE RESTITUTION • RICHMAN ESTATE')
                .setDescription(
                  `Bonjour **${b.client_name || 'Citoyen'}**,\n\n` +
                  `Votre période de location pour **${luxuryTitle}** (${durationNum} ${durationUnit}) arrive à son terme.\n\n` +
                  `Merci de vous rapprocher de notre équipe dans votre salon dédié${foundChannel ? ` <#${foundChannel.id}>` : ''} pour convenir de la remise des clés et de la clôture de votre dossier.\n\n` +
                  `🔖 **Référence Dossier :** \`#${shortRef}\``
                )
                .setFooter({ text: 'Richman Estate' })
                .setTimestamp();

              const dmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setLabel('Facture')
                  .setStyle(ButtonStyle.Link)
                  .setURL(`${config.SITE_URL}/client.html?invoice=${b.id}`)
                  .setEmoji('📄'),
                new ButtonBuilder()
                  .setLabel('Mon Espace Client')
                  .setStyle(ButtonStyle.Link)
                  .setURL(`${config.SITE_URL}/client.html`)
                  .setEmoji('🌐')
              );

              await user.send({ embeds: [dmEmbed], components: [dmRow] }).catch(() => {});
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Erreur vérification retours échus :', err.message);
  }
}

module.exports = {
  checkOverdueRentals
};
