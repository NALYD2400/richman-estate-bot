/**
 * Richman Discord Bot — Ticket Channel Creator & Management Handler
 * Hardened with strict permission boundaries, parameter validation and injection-safe topics.
 */
const { 
  ChannelType, 
  PermissionFlagsBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder 
} = require('discord.js');
const config = require('../config/constants');
const { resolveVehiclePhotoUrl } = require('../services/vehicleUtils');

async function createBookingTicket(client, bookingData) {
  if (!bookingData || typeof bookingData !== 'object') {
    throw new Error("Données de réservation invalides");
  }

  const guild = client.guilds.cache.get(config.GUILD_ID) || client.guilds.cache.first();
  if (!guild) throw new Error("Serveur Discord introuvable");

  const { 
    item_name, 
    type, 
    client_name, 
    dates, 
    amount, 
    id,
    booking_id,
    vehicle_id,
    suite_id,
    notes,
    phone,
    duration,
    photo_url,
    photoUrl
  } = bookingData;

  const cleanDiscordId = String(bookingData.discord_id || bookingData.discordId || bookingData.discord || '').trim();
  const actualBookingId = id || booking_id || '';
  const isSuite = type === 'suite' || type === 'appartement' || type === 'chambre';
  const categoryId = isSuite ? config.CAT_TICKETS_SUITES_ID : config.CAT_TICKETS_LOCATIONS_ID;

  const cleanClient = String(client_name || 'client').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 12);
  const cleanItem = String(item_name || (isSuite ? 'suite' : 'prestige')).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 12);
  const shortRef = actualBookingId ? String(actualBookingId).slice(0, 6).toLowerCase() : Math.random().toString(36).slice(2, 6);
  const channelPrefix = isSuite ? 'suite' : 'ticket';
  const channelName = `${channelPrefix}-${cleanItem}-${cleanClient}`.slice(0, 32);

  // Staff Roles List
  const STAFF_ROLES = [
    config.ROLE_OWNER_ID,
    config.ROLE_ADMIN_ID,
    config.ROLE_GERANT_HOTEL_ID,
    config.ROLE_GERANT_VEHICULES_ID,
    config.ROLE_STAFF_ID,
    config.ROLE_CONCIERGE_ID,
    config.ROLE_VIP_ID,
    config.ROLE_DIAMOND_VIP_ID
  ].filter(Boolean);

  // Permissions setup: Deny @everyone, Allow Bot, Allow Staff
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: guild.members.me ? guild.members.me.id : client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
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

  // Allow Client access if valid Discord Snowflake
  let targetDiscordUser = null;
  if (cleanDiscordId && config.isValidSnowflake(cleanDiscordId)) {
    try {
      const member = await guild.members.fetch(cleanDiscordId).catch(() => null);
      targetDiscordUser = member ? member.user : await client.users.fetch(cleanDiscordId).catch(() => null);
      if (targetDiscordUser) {
        permissionOverwrites.push({
          id: targetDiscordUser.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles
          ]
        });
      }
    } catch (e) {
      console.warn("⚠️ Impossible d'ajouter le membre aux permissions ticket :", e.message);
    }
  }

  // Safe Topic without Injection Vulnerabilities
  const safeTopic = [
    `booking_id:${config.sanitizeTopicValue(actualBookingId)}`,
    `item_id:${config.sanitizeTopicValue(vehicle_id || suite_id || actualBookingId)}`,
    `item_name:${config.sanitizeTopicValue(item_name)}`,
    `discord_id:${config.sanitizeTopicValue(cleanDiscordId)}`,
    `client_name:${config.sanitizeTopicValue(client_name)}`,
    `type:${isSuite ? 'suite' : 'vehicle'}`
  ].join('|');

  // Create Channel
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || null,
    topic: safeTopic,
    permissionOverwrites: permissionOverwrites
  });

  // Resolve photo URL (vehicle or suite)
  let resolvedPhoto = photo_url || photoUrl || (item_name ? resolveVehiclePhotoUrl(item_name) : null);
  if (resolvedPhoto && !String(resolvedPhoto).startsWith('http') && !String(resolvedPhoto).startsWith('/')) {
    resolvedPhoto = null;
  }

  // Action Buttons
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_ticket_accept_loc_${actualBookingId || 'new'}`)
      .setLabel(isSuite ? 'Accepter la Réservation' : 'Accepter la Location')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`btn_ticket_refuse_loc_${actualBookingId || 'new'}`)
      .setLabel('Refuser')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
    new ButtonBuilder()
      .setCustomId('btn_ticket_close')
      .setLabel('Clôturer')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔒')
  );

  // Embed for Ticket Channel
  const embed = new EmbedBuilder()
    .setTitle(isSuite ? `🏨 NOUVELLE RÉSERVATION • #${shortRef.toUpperCase()}` : `🏎️ NOUVELLE DEMANDE DE LOCATION • #${shortRef.toUpperCase()}`)
    .setColor(isSuite ? 0xA855F7 : 0xC5A880)
    .addFields(
      { name: '👤 Client RP', value: String(client_name || 'Citoyen').slice(0, 50), inline: true },
      { name: isSuite ? '🏨 Hébergement' : '🏎️ Véhicule', value: String(item_name || 'Véhicule').slice(0, 50), inline: true },
      { name: '💰 Montant Estimé', value: String(amount || 'Sur devis').slice(0, 30), inline: true },
      { name: '📅 Période & Durée', value: `${String(dates || 'Immédiat').slice(0, 50)} (${duration || '1'} ${isSuite ? 'nuit(s)' : 'jour(s)'})`, inline: true },
      { name: '🔖 Référence Dossier', value: `\`#${shortRef.toUpperCase()}\``, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Richman Estate' });

  if (phone) {
    embed.addFields({ name: '📞 Contact', value: `\`${String(phone).slice(0, 30)}\``, inline: true });
  }
  if (notes) {
    embed.addFields({ name: '📝 Notes', value: String(notes).slice(0, 500), inline: false });
  }

  if (resolvedPhoto && String(resolvedPhoto).startsWith('http')) {
    embed.setImage(resolvedPhoto);
  }

  const notificationContent = (cleanDiscordId && config.isValidSnowflake(cleanDiscordId))
    ? `🛎️ <@${cleanDiscordId}> Votre dossier **#${shortRef.toUpperCase()}** est pris en charge par l'équipe Richman !`
    : `🛎️ Nouveau dossier **#${shortRef.toUpperCase()}** pour **${String(client_name || 'Citoyen').slice(0, 50)}** !`;

  await channel.send({ content: notificationContent, embeds: [embed], components: [actionRow] });

  // Send Direct Message (DM) to user on Discord
  if (targetDiscordUser) {
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(isSuite ? 0xA855F7 : 0xC5A880)
        .setTitle(isSuite ? `🏨 RÉSERVATION ENREGISTRÉE • #${shortRef.toUpperCase()}` : `🏎️ LOCATION ENREGISTRÉE • #${shortRef.toUpperCase()}`)
        .setDescription(
          `Bonjour **${String(client_name || 'Citoyen').slice(0, 50)}**,\n\n` +
          `Votre demande de réservation pour **${String(item_name || 'Véhicule').slice(0, 50)}** a bien été enregistrée !\n\n` +
          `• **Numéro de Référence :** \`#${shortRef.toUpperCase()}\`\n` +
          `• **Montant estimé :** \`${String(amount || 'Sur devis').slice(0, 30)}\`\n` +
          `• **Statut actuel :** ⏳ *En attente de validation*\n\n` +
          `💬 **Votre salon dédié :** <#${channel.id}>\n` +
          `🌐 **Votre Espace Client :** [Accéder à mon Dossier](${config.SITE_URL}/client.html)\n\n` +
          `Vous pouvez échanger directement avec l'équipe Richman dans votre salon <#${channel.id}>.`
        )
        .setFooter({ text: 'Richman Estate' })
        .setTimestamp();

      if (resolvedPhoto && String(resolvedPhoto).startsWith('http')) {
        dmEmbed.setImage(resolvedPhoto);
      }

      await targetDiscordUser.send({ embeds: [dmEmbed] }).catch(() => {});
    } catch (dmErr) {
      console.warn("⚠️ Impossible d'envoyer le MP au client :", dmErr.message);
    }
  }

  return { success: true, channelId: channel.id, channelName: channel.name };
}

module.exports = { createBookingTicket };
