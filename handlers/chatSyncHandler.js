/**
 * Richman Discord Bot — Two-Way Chat Sync Handler (Discord <-> Web)
 * Hardened with message validation, staff privilege checking, and topic parsing safety.
 */
const config = require('../config/constants');
const supabaseService = require('../services/supabase');

async function handleTicketMessage(message) {
  // Ignore bot messages, system messages or DMs
  if (!message || message.author.bot || message.system || !message.guild) return;

  const channel = message.channel;
  if (!channel || !channel.isTextBased()) return;

  // Extract booking info from topic safely
  const topic = channel.topic || '';
  if (!topic.includes('booking_id:') && !channel.name.startsWith('ticket-') && !channel.name.startsWith('suite-') && !channel.name.startsWith('contact-')) {
    return;
  }

  const content = message.content ? message.content.trim() : '';
  if (!content || content.length === 0) return;

  // Limit message length to avoid payload bloat
  const safeContent = content.slice(0, 2000);

  let member = message.member;
  if (!member && message.guild) {
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch (e) {}
  }

  // Extract ticket creator discord_id from topic
  const dIdMatch = topic.match(/discord_id:([^|]+)/);
  const ticketClientDiscordId = dIdMatch ? dIdMatch[1].trim() : null;

  // Sender is staff if they match staff privileges OR if they are an admin/staff responding to someone else's ticket
  let isStaff = config.isStaffMember(member || { id: message.author.id, guild: message.guild });
  if (!isStaff && ticketClientDiscordId && message.author.id !== ticketClientDiscordId) {
    isStaff = true;
  }

  const senderRole = isStaff ? 'staff' : 'client';
  const senderName = member?.displayName || message.author.username;

  // Extract booking_id or contact_id from topic
  const bIdMatch = topic.match(/(?:booking_id|contact_id):([^|]+)/);
  const bookingId = bIdMatch ? bIdMatch[1].trim() : null;

  if (bookingId) {
    try {
      await supabaseService.addBookingMessage(
        bookingId,
        senderName,
        message.author.id,
        senderRole,
        safeContent
      );
    } catch (err) {
      console.error("❌ Erreur sync message Discord -> Supabase :", err.message);
    }
  }
}

module.exports = { handleTicketMessage };
