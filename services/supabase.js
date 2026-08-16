/**
 * Richman Discord Bot — Hardened Supabase Service Client
 */
const https = require('https');
const http = require('http');
const config = require('../config/constants');

function supabaseRequest(endpointPath, method = 'GET', data = null, customHeaders = {}) {
  return new Promise((resolve) => {
    if (!config.SUPABASE_KEY || !config.SUPABASE_URL) {
      return resolve({ status: 500, error: 'Configuration Supabase incomplète' });
    }

    try {
      const fullUrl = new URL(`${config.SUPABASE_URL}/rest/v1/${endpointPath}`);
      const isHttps = fullUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers = {
        'apikey': config.SUPABASE_KEY,
        'Authorization': `Bearer ${config.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...customHeaders
      };

      const options = {
        hostname: fullUrl.hostname,
        port: fullUrl.port || (isHttps ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method: method,
        headers: headers,
        timeout: 10000 // 10s timeout
      };

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', chunk => {
          if (body.length < 5 * 1024 * 1024) { // 5MB guard
            body += chunk;
          }
        });

        res.on('end', () => {
          let parsed = body;
          try { 
            parsed = JSON.parse(body); 
          } catch (e) {
            // Leave as string if not JSON
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed });
          } else {
            resolve({ status: res.statusCode, error: parsed || 'Erreur requête Supabase' });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 408, error: 'Timeout requête Supabase' });
      });

      req.on('error', (err) => {
        console.error("❌ Erreur transport Supabase :", err.message);
        resolve({ status: 500, error: 'Erreur réseau Supabase' });
      });

      if (data) {
        const payloadStr = typeof data === 'string' ? data : JSON.stringify(data);
        req.write(payloadStr);
      }
      req.end();
    } catch (err) {
      console.error("❌ Erreur création requête Supabase :", err.message);
      resolve({ status: 500, error: 'Requête invalide' });
    }
  });
}

const { resolveVehiclePhotoUrl, formatLuxuryCarName } = require('./vehicleUtils');

module.exports = {
  supabaseRequest,
  resolveVehiclePhotoUrl,
  formatLuxuryCarName,
  
  // Bookings
  getBookingById: async (id) => {
    const cleanId = String(id || '').trim();
    const rpcRes = await supabaseRequest('rpc/get_booking_details', 'POST', { p_booking_id: cleanId });
    if (rpcRes && Array.isArray(rpcRes.data) && rpcRes.data.length > 0) {
      return rpcRes;
    }
    const urlId = encodeURIComponent(cleanId);
    return supabaseRequest(`bookings?id=eq.${urlId}&select=*`);
  },
  
  updateBookingStatus: async (id, status) => {
    const cleanId = String(id || '').trim();
    const cleanStatus = (status === 'confirmed' || status === 'cancelled') ? status : 'pending';
    const rpcRes = await supabaseRequest('rpc/update_booking_status', 'POST', {
      p_booking_id: cleanId,
      p_status: cleanStatus
    });
    if (rpcRes && rpcRes.error) {
      const urlId = encodeURIComponent(cleanId);
      return supabaseRequest(`bookings?id=eq.${urlId}`, 'PATCH', { status: cleanStatus });
    }
    return rpcRes;
  },
  
  // Chat Messages
  addBookingMessage: (bookingId, senderName, senderId, senderRole, content) => {
    const cleanBookingId = bookingId ? String(bookingId).trim() : null;
    const cleanContent = String(content || '').slice(0, 4000);
    const cleanSenderName = String(senderName || 'Citoyen').slice(0, 100);
    const cleanSenderRole = (senderRole === 'staff' || senderRole === 'admin') ? 'staff' : 'client';
    const cleanSenderId = senderId ? String(senderId).trim().slice(0, 50) : null;

    return supabaseRequest('rpc/add_booking_message', 'POST', {
      p_booking_id: cleanBookingId,
      p_sender_name: cleanSenderName,
      p_sender_id: cleanSenderId,
      p_sender_role: cleanSenderRole,
      p_content: cleanContent
    });
  },

  // Profiles
  getProfileByDiscordId: (discordId) => {
    const cleanDiscordId = encodeURIComponent(String(discordId || '').trim());
    return supabaseRequest(`profiles?discord_id=eq.${cleanDiscordId}&select=*`);
  },
  
  updateUserProfile: (discordId, updates) => {
    const cleanDiscordId = encodeURIComponent(String(discordId || '').trim());
    return supabaseRequest(`profiles?discord_id=eq.${cleanDiscordId}`, 'PATCH', updates);
  },

  // Stock Counters for Bot Presence & Live Sync
  getVehiculesCount: () => {
    return supabaseRequest('vehicules?select=id,status');
  },
  getSuitesCount: () => {
    return supabaseRequest('suites?select=id,status');
  },

  // Item Status Synchronizer (RPC with Security Definer)
  syncItemStatus: (type, id, status) => {
    const cleanId = String(id || '').trim();
    const cleanType = String(type || 'fleet').toLowerCase();
    const cleanStatus = (status === 'rented') ? 'rented' : 'confirmed';
    return supabaseRequest('rpc/sync_item_status', 'POST', {
      p_type: cleanType,
      p_id: cleanId,
      p_status: cleanStatus
    });
  }
};
