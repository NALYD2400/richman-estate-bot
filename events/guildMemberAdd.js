/**
 * Richman Discord Bot — Event: GuildMemberAdd (Auto Onboarding)
 */
const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'guildMemberAdd',
  async execute(client, member) {
    if (!member || !member.user) return;
    console.log(`👤 Nouveau membre arrivé : ${member.user.tag} (${member.id})`);

    const embed = new EmbedBuilder()
      .setTitle('💎 BIENVENUE À RICHMAN ESTATE RP')
      .setColor('#c5a880')
      .setDescription(
        `Bonjour <@${member.id}>,\n\n` +
        `Bienvenue dans l'écosystème de **Richman Estate**.\n` +
        `Pour accéder aux salons et à vos services de réservation, veuillez vous enregistrer avec votre identité RP dans le salon dédié sur le serveur.`
      )
      .setFooter({ text: 'Richman Estate • Support 24/7' })
      .setTimestamp();

    try {
      await member.send({ embeds: [embed] }).catch(() => {
        // Direct messages may be closed by the user
      });
    } catch (e) {
      console.warn(`Impossible d'envoyer un MP de bienvenue à ${member.user.tag}:`, e.message);
    }
  }
};
