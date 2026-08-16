/**
 * Richman Discord Bot — Event: MessageCreate
 */
const chatSyncHandler = require('../handlers/chatSyncHandler');

module.exports = {
  name: 'messageCreate',
  async execute(client, message) {
    if (!message || message.author?.bot) return;
    try {
      await chatSyncHandler.handleTicketMessage(message);
    } catch (err) {
      console.error("❌ Erreur traitement messageCreate :", err.message);
    }
  }
};
