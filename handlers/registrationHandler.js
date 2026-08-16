/**
 * Richman Discord Bot — RP Registration & Member Auto-Onboarding Handler
 * Hardened with nickname length clamping (32 max), input sanitization, and hierarchy error guards.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config/constants');
const supabaseService = require('../services/supabase');

async function handleRegistrationSubmit(interaction) {
  try {
    const rawFirst = (
      interaction.fields.getTextInputValue('rp_prenom') || 
      interaction.fields.getTextInputValue('reg_firstname') || ''
    ).trim();
    
    const rawLast = (
      interaction.fields.getTextInputValue('rp_nom') || 
      interaction.fields.getTextInputValue('reg_lastname') || ''
    ).trim();
    
    const rawId = (
      interaction.fields.getTextInputValue('rp_id') || 
      interaction.fields.getTextInputValue('reg_phone') || ''
    ).trim();

    // Sanitize names (alphanumeric, spaces, accents, hyphens only)
    const cleanFirst = rawFirst.replace(/[^a-zA-ZÀ-ÿ0-9 -]/g, '').slice(0, 15).trim();
    const cleanLast = rawLast.replace(/[^a-zA-ZÀ-ÿ0-9 -]/g, '').slice(0, 15).trim();
    const cleanId = rawId.replace(/[^0-9]/g, '').slice(0, 10).trim();

    if (!cleanFirst || !cleanLast) {
      return interaction.reply({
        content: '❌ Veuillez renseigner un prénom et un nom RP valides (caractères autorisés : lettres, chiffres, tirets).',
        ephemeral: true
      });
    }

    const baseName = `${cleanFirst} ${cleanLast}`;
    const fullNickname = cleanId ? `${baseName} | ${cleanId}` : baseName;
    const safeNickname = fullNickname.slice(0, 32); // Hard Discord limit

    const member = interaction.member;

    // 1. Rename member on Discord Guild if manageable
    if (member && member.manageable) {
      await member.setNickname(safeNickname).catch(err => {
        console.warn("⚠️ Impossible de changer le pseudo (hiérarchie de rôles) :", err.message);
      });
    }

    // 2. Assign Citizen & Member Roles dynamically
    if (member && member.guild) {
      let citoyenRole = member.guild.roles.cache.find(r => r.name.includes('Citoyen') || r.name.includes('Enregistré'));
      if (!citoyenRole && config.ROLE_CITOYEN_ID) {
        citoyenRole = member.guild.roles.cache.get(config.ROLE_CITOYEN_ID);
      }

      if (citoyenRole && member.guild.members.me?.roles.highest.position > citoyenRole.position) {
        await member.roles.add(citoyenRole).catch(() => {});
      }

      if (config.ROLE_MEMBRE_ID) {
        const membreRole = member.guild.roles.cache.get(config.ROLE_MEMBRE_ID);
        if (membreRole && member.guild.members.me?.roles.highest.position > membreRole.position) {
          await member.roles.add(membreRole).catch(() => {});
        }
      }
    }

    // 3. Upsert Profile in Supabase (Sanitized)
    await supabaseService.updateUserProfile(interaction.user.id, {
      full_name: baseName,
      first_name: cleanFirst,
      last_name: cleanLast,
      rp_id: cleanId || null
    }).catch(e => {
      console.warn("⚠️ Erreur mise à jour Supabase profil :", e.message);
    });

    // 4. Send Welcome Announcement in #arrivee (1537434439338958848)
    const welcomeChannelId = config.WELCOME_CHANNEL_ID || '1537434439338958848';
    const welcomeChannel = interaction.guild ? interaction.guild.channels.cache.get(welcomeChannelId) : null;
    if (welcomeChannel && welcomeChannel.isTextBased()) {
      try {
        const avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 128 });
        const welcomeEmbed = new EmbedBuilder()
          .setAuthor({ name: safeNickname, iconURL: avatarUrl })
          .setTitle('Ho ! Un nouveau membre !')
          .setDescription(
            `🎉 Bienvenue <@${interaction.user.id}> sur le serveur **Richman Estate** ! 🎉\n\n` +
            `Votre compte est désormais activé avec le nom **${safeNickname}**.`
          )
          .setColor('#5865F2')
          .setThumbnail(avatarUrl)
          .setFooter({ text: 'Richman Estate' })
          .setTimestamp();

        await welcomeChannel.send({
          content: `<@${interaction.user.id}>`,
          embeds: [welcomeEmbed]
        }).catch(err => console.warn("⚠️ Impossible d'envoyer l'annonce de bienvenue :", err.message));
      } catch (err) {
        console.warn("⚠️ Erreur création message bienvenue :", err.message);
      }
    }

    return interaction.reply({
      content: `🎉 Félicitations **${safeNickname}** ! Votre enregistrement est validé. Vous avez maintenant accès à l'ensemble du serveur **Richman Estate** !`,
      ephemeral: true
    });
  } catch (err) {
    console.error("❌ Erreur lors de l'enregistrement :", err);
    return interaction.reply({
      content: '⚠️ Une erreur est survenue lors de la validation de votre enregistrement. Veuillez contacter un administrateur.',
      ephemeral: true
    });
  }
}

module.exports = { handleRegistrationSubmit };
