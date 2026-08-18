/**
 * Richman Discord Bot — Event: ChannelDelete
 * Auto-archives booking and returns vehicles/suites to available if channel is deleted manually on Discord.
 */
const { Events } = require('discord.js');
const supabaseService = require('../services/supabase');
const config = require('../config/constants');

module.exports = {
  name: Events.ChannelDelete || 'channelDelete',
  async execute(client, channel) {
    try {
      if (!channel || !channel.topic) return;

      const topic = channel.topic || '';
      const bIdMatch = topic.match(/booking_id:([^|]+)/);
      const vIdMatch = topic.match(/(?:item_id|vehicle_id):([^|]+)/);
      const vNameMatch = topic.match(/(?:item_name|vehicle_name):([^|]+)/);
      const isSuite = (channel.name && channel.name.startsWith('suite-')) || topic.includes('type:suite');

      const bookingId = bIdMatch ? bIdMatch[1].trim() : null;
      const itemId = vIdMatch ? vIdMatch[1].trim() : null;
      const itemName = vNameMatch ? vNameMatch[1].trim() : null;

      if (bookingId && bookingId !== 'new') {
        const { data: bList } = await supabaseService.getBookingById(bookingId);
        const currentBooking = bList && bList[0];

        // If not already closed or completed, mark as closed/archived
        if (currentBooking && currentBooking.status !== 'closed' && currentBooking.status !== 'completed') {
          await supabaseService.updateBookingStatus(bookingId, 'closed').catch(() => {});
          await supabaseService.addBookingMessage(
            bookingId,
            'Système Richman',
            client.user.id,
            'system',
            '🔒 Le salon ticket Discord a été supprimé. Le dossier a été automatiquement archivé.'
          ).catch(() => {});
        }
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
      }
    } catch (err) {
      console.warn("⚠️ Erreur événement channelDelete :", err.message);
    }
  }
};
