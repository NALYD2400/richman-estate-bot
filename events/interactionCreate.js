/**
 * Richman Discord Bot — Event: InteractionCreate (Buttons, Modals & Slash Commands)
 * Hardened with strict staff privilege verification on all administrative actions.
 */
const { 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ActionRowBuilder, 
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags 
} = require('discord.js');
const config = require('../config/constants');
const registrationHandler = require('../handlers/registrationHandler');
const slashCommands = require('../commands/slashCommands');
const supabaseService = require('../services/supabase');
const { resolveVehiclePhotoUrl, formatLuxuryCarName } = require('../services/vehicleUtils');
const { updateBotPresence } = require('./ready');

module.exports = {
  name: 'interactionCreate',
  async execute(client, interaction) {
    try {
      // 1. Slash Commands
      if (interaction.isChatInputCommand()) {
        return await slashCommands.handleSlashCommand(interaction);
      }

      // 2. Modal Submissions
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_register_form' || interaction.customId === 'registration_modal') {
          return await registrationHandler.handleRegistrationSubmit(interaction);
        }

        // Staff DM Reply Modal
        if (interaction.customId.startsWith('modal_staff_dm_reply_')) {
          if (!config.isStaffMember(interaction.member)) {
            return interaction.reply({
              content: '❌ **Accès Refusé** : Action réservée au personnel.',
              ephemeral: true
            });
          }

          const targetDiscordId = interaction.customId.replace('modal_staff_dm_reply_', '').trim();
          const replyMsg = interaction.fields.getTextInputValue('staff_dm_message');
          const staffName = interaction.member?.displayName || interaction.user.username;

          // Topic parsing for booking_id
          const topic = interaction.channel.topic || '';
          const bIdMatch = topic.match(/booking_id:([^|]+)/);
          const bookingId = bIdMatch ? bIdMatch[1].trim() : null;

          if (bookingId) {
            await supabaseService.addBookingMessage(bookingId, staffName, interaction.user.id, 'staff', replyMsg);
          }

          await interaction.channel.send(`💬 **${staffName} (Staff MP) :** ${replyMsg}`).catch(() => {});

          if (targetDiscordId && config.isValidSnowflake(targetDiscordId)) {
            try {
              const targetUser = await client.users.fetch(targetDiscordId).catch(() => null);
              if (targetUser) {
                await targetUser.send(`**${staffName} :** ${replyMsg}`).catch(() => {});
              }
            } catch (e) {}
          }

          return interaction.reply({ content: '✅ Réponse envoyée au client et synchronisée.', ephemeral: true });
        }
      }

      // 3. Button Interactions
      if (interaction.isButton()) {
        const customId = interaction.customId;

        // A) Accept Rules Button
        if (customId === 'btn_accept_rules') {
          const member = interaction.member;
          if (member && config.ROLE_MEMBRE_ID) {
            const role = interaction.guild?.roles.cache.get(config.ROLE_MEMBRE_ID);
            if (role && interaction.guild?.members.me?.roles.highest.position > role.position) {
              await member.roles.add(role).catch(() => {});
            }
          }
          return interaction.reply({
            content: '✅ Règlement accepté ! Vous pouvez maintenant procéder à votre enregistrement RP.',
            ephemeral: true
          });
        }

        // B) Open Registration Modal Button
        if (customId === 'btn_open_modal') {
          const member = interaction.member;
          const hasCitoyenRole = member.roles.cache.some(r => r.name.includes('Citoyen') || r.name.includes('Enregistré') || r.id === config.ROLE_CITOYEN_ID);

          if (hasCitoyenRole) {
            return interaction.reply({
              content: `❌ **Vous êtes déjà enregistré** sous le nom **${member.displayName}** !`,
              ephemeral: true
            });
          }

          const modal = new ModalBuilder()
            .setCustomId('modal_register_form')
            .setTitle('Enregistrement Richman Estate');

          const prenomInput = new TextInputBuilder()
            .setCustomId('rp_prenom')
            .setLabel('Prénom RP')
            .setPlaceholder('ex: Marc')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(15)
            .setRequired(true);

          const nomInput = new TextInputBuilder()
            .setCustomId('rp_nom')
            .setLabel('Nom RP')
            .setPlaceholder('ex: Louis')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(15)
            .setRequired(true);

          const idInput = new TextInputBuilder()
            .setCustomId('rp_id')
            .setLabel('Numéro / ID Citoyen')
            .setPlaceholder('ex: 62336')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder().addComponents(prenomInput),
            new ActionRowBuilder().addComponents(nomInput),
            new ActionRowBuilder().addComponents(idInput)
          );

          return await interaction.showModal(modal);
        }

        // C) Administrative Buttons: MUST Require Staff Privileges
        if (
          customId === 'btn_ticket_close' || customId.startsWith('close_ticket_') ||
          customId.startsWith('btn_ticket_accept_loc_') || customId.startsWith('confirm_booking_') ||
          customId.startsWith('btn_ticket_refuse_loc_') || customId.startsWith('refuse_booking_') ||
          customId.startsWith('btn_ticket_reply_dm_')
        ) {
          if (!config.isStaffMember(interaction.member)) {
            return interaction.reply({
              content: '❌ **Accès Refusé** : Cette action est strictement réservée au personnel et administrateurs.',
              ephemeral: true
            });
          }
        }

        // Action: Open DM Reply Modal for Staff
        if (customId.startsWith('btn_ticket_reply_dm_')) {
          let targetDiscordId = customId.replace('btn_ticket_reply_dm_', '').trim();
          if (!targetDiscordId || targetDiscordId === 'undefined') {
            const topic = interaction.channel.topic || '';
            const match = topic.match(/discord_id:([^|]+)/);
            if (match) targetDiscordId = match[1];
          }

          const replyModal = new ModalBuilder()
            .setCustomId(`modal_staff_dm_reply_${targetDiscordId}`)
            .setTitle('Répondre au client par MP');

          const replyInput = new TextInputBuilder()
            .setCustomId('staff_dm_message')
            .setLabel('Message privé au client')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Tapez votre réponse ici...')
            .setRequired(true);

          replyModal.addComponents(new ActionRowBuilder().addComponents(replyInput));
          return await interaction.showModal(replyModal);
        }

        // Action: Close Ticket
        if (customId === 'btn_ticket_close' || customId.startsWith('close_ticket_')) {
          await interaction.deferReply({ ephemeral: false }).catch(() => {});

          const topic = interaction.channel.topic || '';
          const bIdMatch = topic.match(/booking_id:([^|]+)/);
          const vIdMatch = topic.match(/(?:item_id|vehicle_id):([^|]+)/);
          const vNameMatch = topic.match(/(?:item_name|vehicle_name):([^|]+)/);
          const isSuite = interaction.channel.name.startsWith('suite-') || topic.includes('type:suite');
          const bookingId = bIdMatch ? bIdMatch[1].trim() : null;
          const itemId = vIdMatch ? vIdMatch[1].trim() : null;
          const itemName = vNameMatch ? vNameMatch[1].trim() : null;

          if (bookingId) {
            await supabaseService.updateBookingStatus(bookingId, 'closed').catch(() => {});
            await supabaseService.addBookingMessage(
              bookingId,
              interaction.member?.displayName || interaction.user.username || 'Staff Richman',
              interaction.user.id,
              'staff',
              '🔒 Le salon ticket a été clôturé depuis Discord et le dossier est archivé.'
            ).catch(() => {});
          }

          // Ensure vehicle / suite is available in showroom
          if (itemId || itemName) {
            if (!isSuite) {
              let vTargetId = itemId;
              const { data: vList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `vehicules?id=eq.${itemId}&limit=1`
                  : `vehicules?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (vList && vList.length > 0) vTargetId = vList[0].id;
              if (vTargetId) {
                await supabaseService.syncItemStatus('fleet', vTargetId, 'confirmed').catch(() => {});
                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-fleet-vehicle-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ vehicleId: vTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            } else {
              let sTargetId = itemId;
              const { data: sList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `suites?id=eq.${itemId}&limit=1`
                  : `suites?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (sList && sList.length > 0) sTargetId = sList[0].id;
              if (sTargetId) {
                await supabaseService.syncItemStatus('suite', sTargetId, 'confirmed').catch(() => {});
                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-hotel-suite-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ suiteId: sTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            }
          }

          const closeEmbed = new EmbedBuilder()
            .setColor(0xEF4444)
            .setTitle('🔒 FERMETURE DU TICKET')
            .setDescription(`Ticket clôturé par **<@${interaction.user.id}>**.\n\nLe dossier a été mis à jour et archivé sur le panel web.\n⚠️ **Suppression de ce salon dans 3 secondes...**`)
            .setFooter({ text: 'Richman Estate' })
            .setTimestamp();

          await interaction.editReply({ embeds: [closeEmbed] }).catch(() => {});

          setTimeout(() => {
            interaction.channel.delete('Ticket clôturé par le staff').catch(() => {});
          }, 3000);
          return;
        }

        // Action: Confirm / Accept Booking
        if (customId.startsWith('btn_ticket_accept_loc_') || customId.startsWith('confirm_booking_')) {
          await interaction.deferReply({ ephemeral: false }).catch(() => {});

          let bookingId = customId.replace('btn_ticket_accept_loc_', '').replace('confirm_booking_', '').trim();
          const topic = interaction.channel.topic || '';
          const vIdMatch = topic.match(/(?:item_id|vehicle_id):([^|]+)/);
          const vNameMatch = topic.match(/(?:item_name|vehicle_name):([^|]+)/);
          const dIdMatch = topic.match(/discord_id:([^|]+)/);
          const cNameMatch = topic.match(/client_name:([^|]+)/);
          const isSuite = interaction.channel.name.startsWith('suite-') || topic.includes('type:suite');

          if (bookingId === 'new') {
            const bIdMatch = topic.match(/booking_id:([^|]+)/);
            if (bIdMatch) bookingId = bIdMatch[1].trim();
          }

          const itemId = vIdMatch ? vIdMatch[1] : null;
          const itemName = vNameMatch ? vNameMatch[1] : (isSuite ? 'Hébergement' : 'Véhicule');
          const discordId = dIdMatch ? dIdMatch[1] : null;
          const clientName = cNameMatch ? cNameMatch[1] : 'Citoyen';

          if (bookingId && bookingId !== 'new') {
            await supabaseService.updateBookingStatus(bookingId, 'confirmed').catch(() => {});
            await supabaseService.addBookingMessage(
              bookingId,
              interaction.member?.displayName || interaction.user.username || 'Staff Richman',
              interaction.user.id,
              'staff',
              `✅ Votre réservation pour ${itemName} a été ACCEPTÉE et VALIDÉE.`
            ).catch(() => {});
          }

          if (itemId || itemName) {
            if (!isSuite) {
              let vTargetId = itemId;
              const { data: vList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `vehicules?id=eq.${itemId}&limit=1`
                  : `vehicules?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (vList && vList.length > 0) vTargetId = vList[0].id;

              if (vTargetId) {
                await supabaseService.syncItemStatus('fleet', vTargetId, 'rented').catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-fleet-vehicle-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ vehicleId: vTargetId, status: 'rented' })
                  }).catch(() => {});
                } catch (e) {}
              }
            } else {
              let sTargetId = itemId;
              const { data: sList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `suites?id=eq.${itemId}&limit=1`
                  : `suites?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (sList && sList.length > 0) sTargetId = sList[0].id;
              if (sTargetId) {
                await supabaseService.syncItemStatus('suite', sTargetId, 'rented').catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-hotel-suite-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ suiteId: sTargetId, status: 'rented' })
                  }).catch(() => {});
                } catch (e) {}
              }
            }
            updateBotPresence(client).catch(() => {});
          }

          // Send DM to Player
          if (discordId && config.isValidSnowflake(discordId)) {
            try {
              const targetUser = await client.users.fetch(discordId).catch(() => null);
              if (targetUser) {
                const photoUrl = isSuite ? null : resolveVehiclePhotoUrl(itemName);
                const luxuryTitle = isSuite ? itemName : formatLuxuryCarName(itemName);
                const shortRef = (bookingId && bookingId !== 'new') ? bookingId.slice(0, 6).toUpperCase() : 'VIP';
                const acceptEmbed = new EmbedBuilder()
                  .setColor(0x10B981)
                  .setTitle(isSuite ? '🏨 RÉSERVATION CONFIRMÉE • RICHMAN ESTATE' : '🎉 LOCATION CONFIRMÉE • RICHMAN ESTATE')
                  .setDescription(
                    `Bonjour **${clientName}**,\n\n` +
                    `Votre demande de réservation pour **${luxuryTitle}** a été **VALIDÉE** !\n\n` +
                    `🔖 **Référence Dossier :** \`#${shortRef}\`\n` +
                    (isSuite 
                      ? `🔑 **Remise des clés :** Votre hébergement est prêt pour votre séjour.\n`
                      : `🔑 **Mise à disposition :** Votre véhicule est préparé et prêt pour la remise des clés.\n`
                    ) +
                    `💬 **Salon d'échange :** Rendez-vous dans votre salon <#${interaction.channel.id}> ou sur votre [Espace Client Web](${config.SITE_URL}/client.html) pour convenir des modalités.`
                  )
                  .setFooter({ text: 'Richman Estate' })
                  .setTimestamp();

                const dmFiles = [];
                if (photoUrl && String(photoUrl).startsWith('http')) {
                  try {
                    const ext = photoUrl.split('?')[0].split('.').pop() || 'webp';
                    const filename = `accept_${shortRef || Date.now()}.${ext}`;
                    const attachment = new AttachmentBuilder(photoUrl, { name: filename });
                    acceptEmbed.setImage(`attachment://${filename}`);
                    dmFiles.push(attachment);
                  } catch (e) {
                    acceptEmbed.setImage(photoUrl);
                  }
                }
                await targetUser.send({ embeds: [acceptEmbed], files: dmFiles }).catch(() => {});
              }
            } catch (dmErr) {
              console.warn("⚠️ Impossible d'envoyer le MP de confirmation:", dmErr.message);
            }
          }

          // Move channel to Returns category if configured
          if (config.CAT_TICKETS_RETOURS_ID && interaction.channel.setParent) {
            try {
              await interaction.channel.setParent(config.CAT_TICKETS_RETOURS_ID, { lockPermissions: false });
            } catch (moveErr) {
              console.warn("⚠️ Déplacement vers la catégorie retour :", moveErr.message);
            }
          }

          const luxuryTitle = isSuite ? itemName : formatLuxuryCarName(itemName);
          const statusEmbed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle(isSuite ? '✅ RÉSERVATION ACCEPTÉE ET VALIDÉE' : '✅ LOCATION ACCEPTÉE ET VALIDÉE')
            .setDescription(
              `Dossier validé par **<@${interaction.user.id}>**.\n\n` +
              (isSuite
                ? `🏨 **Hébergement :** La réservation pour **${luxuryTitle}** a été confirmée.\n` +
                  `🔑 **Remise des clés :** Vous pouvez dès à présent convenir des modalités d'arrivée directement ici dans ce salon.`
                : `🔑 **Mise à disposition :** Le statut du véhicule **${luxuryTitle}** a été passé en **En Location**.\n` +
                  `💬 **Remise des clés :** Vous pouvez dès à présent convenir du lieu et de l'heure du rendez-vous directement ici dans ce salon.`
              )
            )
            .setFooter({ text: 'Richman Estate' })
            .setTimestamp();

          const invoiceUrl = `${config.SITE_URL}/client.html?invoice=${bookingId || 'new'}`;
          const returnActionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`btn_ticket_return_${bookingId || 'new'}`)
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

          return await interaction.editReply({ embeds: [statusEmbed], components: [returnActionRow] }).catch(() => {});
        }

        // Action: Validate Return / Check-out
        if (customId.startsWith('btn_ticket_return_') || customId.startsWith('return_booking_')) {
          await interaction.deferReply({ ephemeral: false }).catch(() => {});

          let bookingId = customId.replace('btn_ticket_return_', '').replace('return_booking_', '').trim();
          const topic = interaction.channel.topic || '';
          const vIdMatch = topic.match(/(?:item_id|vehicle_id):([^|]+)/);
          const vNameMatch = topic.match(/(?:item_name|vehicle_name):([^|]+)/);
          const dIdMatch = topic.match(/discord_id:([^|]+)/);
          const cNameMatch = topic.match(/client_name:([^|]+)/);
          const isSuite = interaction.channel.name.startsWith('suite-') || topic.includes('type:suite');

          if (bookingId === 'new') {
            const bIdMatch = topic.match(/booking_id:([^|]+)/);
            if (bIdMatch) bookingId = bIdMatch[1].trim();
          }

          const itemId = vIdMatch ? vIdMatch[1] : null;
          const itemName = vNameMatch ? vNameMatch[1] : (isSuite ? 'Hébergement' : 'Véhicule');
          const discordId = dIdMatch ? dIdMatch[1] : null;
          const clientName = cNameMatch ? cNameMatch[1] : 'Citoyen';
          const luxuryTitle = isSuite ? itemName : formatLuxuryCarName(itemName);
          const shortRef = (bookingId && bookingId !== 'new') ? bookingId.slice(0, 6).toUpperCase() : 'VIP';

          if (bookingId && bookingId !== 'new') {
            await supabaseService.updateBookingStatus(bookingId, 'completed').catch(() => {});
            await supabaseService.addBookingMessage(
              bookingId,
              interaction.member?.displayName || interaction.user.username || 'Staff Richman',
              interaction.user.id,
              'staff',
              isSuite
                ? `🔑 Le check-out pour ${luxuryTitle} a été validé. Séjour clôturé.`
                : `🔄 La restitution pour ${luxuryTitle} a été validée avec succès. Véhicule réintégré à la flotte.`
            ).catch(() => {});
          }

          // Return item to confirmed (disponible)
          if (itemId || itemName) {
            if (!isSuite) {
              let vTargetId = itemId;
              const { data: vList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `vehicules?id=eq.${itemId}&limit=1`
                  : `vehicules?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (vList && vList.length > 0) vTargetId = vList[0].id;
              if (vTargetId) {
                await supabaseService.syncItemStatus('fleet', vTargetId, 'confirmed').catch(() => {});
                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-fleet-vehicle-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ vehicleId: vTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            } else {
              let sTargetId = itemId;
              const { data: sList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `suites?id=eq.${itemId}&limit=1`
                  : `suites?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (sList && sList.length > 0) sTargetId = sList[0].id;
              if (sTargetId) {
                await supabaseService.syncItemStatus('suite', sTargetId, 'confirmed').catch(() => {});
                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-hotel-suite-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ suiteId: sTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            }
            updateBotPresence(client).catch(() => {});
          }

          // Send Return Confirmation DM
          if (discordId && config.isValidSnowflake(discordId)) {
            try {
              const targetUser = await client.users.fetch(discordId).catch(() => null);
              if (targetUser) {
                const photoUrl = isSuite ? null : resolveVehiclePhotoUrl(itemName);
                const returnDmEmbed = new EmbedBuilder()
                  .setColor(0x10B981)
                  .setTitle(isSuite ? '🏨 SÉJOUR CLÔTURÉ • MERCI DE VOTRE VISITE' : '🚗 RESTITUTION VALIDÉE • LOCATION TERMINÉE')
                  .setDescription(
                    `Bonjour **${clientName}**,\n\n` +
                    `La restitution pour **${luxuryTitle}** a été validée par notre équipe.\n\n` +
                    `🔖 **Référence Dossier :** \`#${shortRef}\`\n` +
                    `📄 **Facture & Reçu :** Votre reçu officiel reste disponible dans votre [Espace Client](${config.SITE_URL}/client.html).\n\n` +
                    `Toute l'équipe de Richman Estate vous remercie pour votre confiance !`
                  )
                  .setFooter({ text: 'Richman Estate' })
                  .setTimestamp();

                const dmFiles = [];
                if (photoUrl && String(photoUrl).startsWith('http')) {
                  try {
                    const ext = photoUrl.split('?')[0].split('.').pop() || 'webp';
                    const filename = `return_${shortRef || Date.now()}.${ext}`;
                    const attachment = new AttachmentBuilder(photoUrl, { name: filename });
                    returnDmEmbed.setImage(`attachment://${filename}`);
                    dmFiles.push(attachment);
                  } catch (e) {
                    returnDmEmbed.setImage(photoUrl);
                  }
                }
                await targetUser.send({ embeds: [returnDmEmbed], files: dmFiles }).catch(() => {});
              }
            } catch (dmErr) {}
          }

          const returnEmbed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle(isSuite ? '🔑 CHECK-OUT EFFECTUÉ & SÉJOUR CLÔTURÉ' : '🔄 RESTITUTION VALIDÉE & LOCATION TERMINÉE')
            .setDescription(
              `Restitution validée par **<@${interaction.user.id}>**.\n\n` +
              (isSuite 
                ? `🏨 L'hébergement **${luxuryTitle}** a été libéré et inspecté.\n✅ Séjour archivé et disponible pour les prochaines réservations.`
                : `🚗 Le véhicule **${luxuryTitle}** a été inspecté et réintégré à la flotte.\n✅ Caution débloquée et dossier clôturé avec succès.`
              ) +
              `\n\n⚠️ **Fermeture automatique de ce salon dans 5 secondes...**`
            )
            .setFooter({ text: 'Richman Estate' })
            .setTimestamp();

          await interaction.editReply({ embeds: [returnEmbed] }).catch(() => {});

          setTimeout(() => {
            interaction.channel.delete('Restitution validée par le staff').catch(() => {});
          }, 5000);
          return;
        }

        // Action: Refuse Booking
        if (customId.startsWith('btn_ticket_refuse_loc_') || customId.startsWith('refuse_booking_')) {
          await interaction.deferReply({ ephemeral: false }).catch(() => {});

          let bookingId = customId.replace('btn_ticket_refuse_loc_', '').replace('refuse_booking_', '').trim();
          const topic = interaction.channel.topic || '';
          const dIdMatch = topic.match(/discord_id:([^|]+)/);
          const vIdMatch = topic.match(/(?:item_id|vehicle_id):([^|]+)/);
          const vNameMatch = topic.match(/(?:item_name|vehicle_name):([^|]+)/);
          const cNameMatch = topic.match(/client_name:([^|]+)/);
          const isSuite = interaction.channel.name.startsWith('suite-') || topic.includes('type:suite');

          if (bookingId === 'new') {
            const bIdMatch = topic.match(/booking_id:([^|]+)/);
            if (bIdMatch) bookingId = bIdMatch[1].trim();
          }

          const itemId = vIdMatch ? vIdMatch[1] : null;
          const discordId = dIdMatch ? dIdMatch[1] : null;
          const itemName = vNameMatch ? vNameMatch[1] : (isSuite ? 'Hébergement' : 'Véhicule');
          const clientName = cNameMatch ? cNameMatch[1] : 'Citoyen';

          if (bookingId && bookingId !== 'new') {
            await supabaseService.updateBookingStatus(bookingId, 'cancelled').catch(() => {});
            await supabaseService.addBookingMessage(
              bookingId,
              interaction.member?.displayName || interaction.user.username || 'Staff Richman',
              interaction.user.id,
              'staff',
              `❌ Votre demande de réservation pour ${itemName} n'a pas pu être retenue.`
            ).catch(() => {});
          }

          if (itemId || itemName) {
            if (!isSuite) {
              let vTargetId = itemId;
              const { data: vList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `vehicules?id=eq.${itemId}&limit=1`
                  : `vehicules?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (vList && vList.length > 0) vTargetId = vList[0].id;

              if (vTargetId) {
                await supabaseService.syncItemStatus('fleet', vTargetId, 'confirmed').catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-fleet-vehicle-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ vehicleId: vTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            } else {
              let sTargetId = itemId;
              const { data: sList } = await supabaseService.supabaseRequest(
                (itemId && itemId.length > 10 && !itemId.includes('-')) 
                  ? `suites?id=eq.${itemId}&limit=1`
                  : `suites?name=ilike.${encodeURIComponent(itemName)}&limit=1`
              );
              if (sList && sList.length > 0) sTargetId = sList[0].id;
              if (sTargetId) {
                await supabaseService.syncItemStatus('suite', sTargetId, 'confirmed').catch(() => {});

                try {
                  const LOCAL_PORT = config.PORT || 3001;
                  await fetch(`http://127.0.0.1:${LOCAL_PORT}/api/update-hotel-suite-status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.API_SECRET}` },
                    body: JSON.stringify({ suiteId: sTargetId, status: 'confirmed' })
                  }).catch(() => {});
                } catch (e) {}
              }
            }
            updateBotPresence(client).catch(() => {});
          }

          // Send Refusal DM
          if (discordId && config.isValidSnowflake(discordId)) {
            try {
              const targetUser = await client.users.fetch(discordId).catch(() => null);
              if (targetUser) {
                const photoUrl = isSuite ? null : resolveVehiclePhotoUrl(itemName);
                const luxuryTitle = isSuite ? itemName : formatLuxuryCarName(itemName);
                const shortRef = (bookingId && bookingId !== 'new') ? bookingId.slice(0, 6).toUpperCase() : 'VIP';
                const refuseDmEmbed = new EmbedBuilder()
                  .setColor(0xEF4444)
                  .setTitle('❌ DEMANDE NON RETENUE • RICHMAN ESTATE')
                  .setDescription(
                    `Bonjour **${clientName}**,\n\n` +
                    `Votre demande de réservation pour **${luxuryTitle}** n'a pas pu être validée pour le créneau demandé.\n\n` +
                    `🔖 **Référence Dossier :** \`#${shortRef}\`\n` +
                    `🌐 **Espace Client :** [Voir mon Dossier](${config.SITE_URL}/client.html)\n\n` +
                    `L'équipe Richman reste à votre disposition si vous souhaitez choisir un autre modèle ou une autre date.`
                  )
                  .setFooter({ text: 'Richman Estate' })
                  .setTimestamp();

                const dmFiles = [];
                if (photoUrl && String(photoUrl).startsWith('http')) {
                  try {
                    const ext = photoUrl.split('?')[0].split('.').pop() || 'webp';
                    const filename = `refuse_${shortRef || Date.now()}.${ext}`;
                    const attachment = new AttachmentBuilder(photoUrl, { name: filename });
                    refuseDmEmbed.setImage(`attachment://${filename}`);
                    dmFiles.push(attachment);
                  } catch (e) {
                    refuseDmEmbed.setImage(photoUrl);
                  }
                }
                await targetUser.send({ embeds: [refuseDmEmbed], files: dmFiles }).catch(() => {});
              }
            } catch (dmErr) {}
          }

          const refuseEmbed = new EmbedBuilder()
            .setColor(0xEF4444)
            .setTitle('❌ DEMANDE DE RÉSERVATION REFUSÉE')
            .setDescription(`Dossier refusé par **<@${interaction.user.id}>**.\nLe statut a été mis à jour et le client prévenu.`)
            .setFooter({ text: 'Richman Estate' })
            .setTimestamp();

          return await interaction.editReply({ embeds: [refuseEmbed] }).catch(() => {});
        }
      }
      }
    } catch (err) {
      console.error("❌ Erreur InteractionCreate :", err);
      if (interaction && !interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: '⚠️ Une erreur inattendue est survenue.', ephemeral: true }).catch(() => {});
      }
    }
  }
};
