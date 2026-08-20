/**
 * Richman Discord Bot — Slash Commands Registry & Execution
 * Hardened with Administrator permission boundaries on setup commands.
 */
const { 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const config = require('../config/constants');

const commands = [
  new SlashCommandBuilder()
    .setName('reglement')
    .setDescription('Affiche le règlement officiel de Richman Estate RP'),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Affiche les statistiques de réservations et de la flotte'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Vérifie la latence du bot et de la base de données'),
  new SlashCommandBuilder()
    .setName('setup-reglement')
    .setDescription('Déploie l\'embed du Règlement avec bouton de validation (Admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('setup-enregistrement')
    .setDescription('Déploie l\'embed d\'Enregistrement avec formulaire modal (Admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

async function registerSlashCommands() {
  if (!config.TOKEN || !config.CLIENT_ID) {
    console.warn("⚠️ Impossible d'enregistrer les slash commands : TOKEN ou CLIENT_ID manquant");
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.TOKEN);
  try {
    console.log('🔄 Actualisation des commandes d\'application (/) ...');
    if (config.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(config.CLIENT_ID, config.GUILD_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log('✅ Commandes d\'application (/) enregistrées pour la guilde !');
    } else {
      await rest.put(
        Routes.applicationCommands(config.CLIENT_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log('✅ Commandes d\'application (/) globales enregistrées !');
    }
  } catch (error) {
    console.error('❌ Erreur lors de l\'enregistrement des slash commands :', error.message);
  }
}

async function handleSlashCommand(interaction) {
  const { commandName } = interaction;

  try {
    if (commandName === 'ping') {
      const sent = await interaction.reply({ content: '🏓 Pong...', fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      return interaction.editReply(`🏓 Pong ! Latence bot : **${latency}ms**.`);
    }

    if (commandName === 'stats') {
      return interaction.reply({
        content: `📊 **Statistiques Richman Estate** :\n• Support & Staff : **24/7 Actif**\n• Passerelle Web & Discord : **Opérationnelle**\n• Uptime : **${Math.round(process.uptime())}s**`,
        ephemeral: true
      });
    }

    if (commandName === 'reglement') {
      const embed = new EmbedBuilder()
        .setTitle('📜 Règlement Officiel de Richman Estate')
        .setDescription(
          '1. **Fair-Play & RP Luxe :** Le respect absolu entre tous les citoyens est exigé.\n' +
          '2. **No HRP & Soundboards :** Restez dans votre personnage RP en tout temps.\n' +
          '3. **Véhicules & Résidences :** Les contrats signés auprès du domaine sont fermes.'
        )
        .setColor('#3b82f6')
        .setFooter({ text: 'Richman Estate RP' });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    // Admin Commands: Strict Permission Check
    if (commandName === 'setup-reglement' || commandName === 'setup-enregistrement') {
      if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) && !config.isStaffMember(interaction.member)) {
        return interaction.reply({
          content: '❌ **Accès Refusé** : Cette commande nécessite des privilèges Administrateur.',
          ephemeral: true
        });
      }

      if (commandName === 'setup-reglement') {
        const embedReglement = new EmbedBuilder()
          .setTitle('📜 Règlement Officiel de Richman Estate')
          .setDescription('Bienvenue sur le serveur Richman Estate.\n\n1. **Fair-Play & RP Luxe :** Le respect absolu entre tous les citoyens est exigé.\n2. **No HRP & Soundboards :** Restez dans votre personnage RP en tout temps.\n3. **Véhicules & Résidences :** Les contrats signés auprès de la Conciergerie sont fermes.\n\n*Veuillez valider le règlement pour débloquer l\'enregistrement.*')
          .setColor('#3b82f6');

        const btnReglement = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_accept_rules')
            .setLabel("J'accepte le règlement")
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
        );

        await interaction.channel.send({ embeds: [embedReglement], components: [btnReglement] });
        return interaction.reply({ content: '✅ Panneau de Règlement déployé !', ephemeral: true });
      }

      if (commandName === 'setup-enregistrement') {
        const embedEnregistrement = new EmbedBuilder()
          .setTitle('🎉 Bienvenue sur Richman Estate !')
          .setDescription('Merci de rejoindre Richman Estate.\n\n**Avant de commencer**, merci de bien vouloir compléter votre enregistrement en cliquant sur le bouton ci-dessous.\n\n*Vos informations restent confidentielles et sécurisées.*')
          .setColor('#5865F2');

        const btnEnregistrement = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn_open_modal')
            .setLabel('Créer un compte Richman Estate')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
        );

        await interaction.channel.send({ embeds: [embedEnregistrement], components: [btnEnregistrement] });
        return interaction.reply({ content: '✅ Panneau d\'Enregistrement déployé !', ephemeral: true });
      }
    }
  } catch (err) {
    console.error("❌ Erreur exécution slash command :", err.message);
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '⚠️ Erreur lors de l\'exécution de la commande.', ephemeral: true }).catch(() => {});
    }
  }
}

module.exports = { registerSlashCommands, handleSlashCommand };
