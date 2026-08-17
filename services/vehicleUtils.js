/**
 * Richman Discord Bot — Vehicle Formatting & Resolution Helpers
 */

const config = require('../config/constants');

function formatLuxuryCarName(rawName) {
  if (!rawName) return 'Véhicule';
  const clean = String(rawName).trim();
  const map = {
    'ENTITYXF': 'Överflöd Entity XF',
    'ENTITY2': 'Överflöd Entity MT',
    'ENTITY3': 'Överflöd Entity MT Concept',
    'ENTITYXXR': 'Överflöd Entity XXR',
    'ITALIRSX': 'Grotti Itali RSX',
    'FURIA': 'Grotti Furia Hypercar',
    'KRIEGER': 'Benefactor Krieger',
    'THRAX': 'Trufade Thrax',
    'TEMPESTA': 'Pegassi Tempesta',
    'T20': 'Progen T20 Hypercar',
    'ADDER': 'Truffade Adder Hypercar',
    'AUTARCH': 'Överflöd Autarch Hypercar'
  };
  return map[clean.toUpperCase()] || clean;
}

function resolveVehiclePhotoUrl(carName, customSpecs = null) {
  if (customSpecs) {
    try {
      if (typeof customSpecs === 'string' && customSpecs.startsWith('{')) {
        const meta = JSON.parse(customSpecs);
        if (meta.media_url) {
          if (typeof meta.media_url === 'string' && meta.media_url.startsWith('[')) {
            const arr = JSON.parse(meta.media_url);
            if (arr && arr[0] && String(arr[0]).startsWith('http')) return arr[0];
          } else if (typeof meta.media_url === 'string' && meta.media_url.startsWith('http')) {
            return meta.media_url;
          }
        }
      }
    } catch (e) {}
  }

  if (!carName) return 'https://ghbeopdnfdxuqfjzmmeb.supabase.co/storage/v1/object/public/public_assets/logo.webp';
  const raw = String(carName).toUpperCase().trim();
  const LUXURY_TO_SPAWN = {
    'ÖVERFLÖD ENTITY MT': 'entity2',
    'OVERFLOD ENTITY MT': 'entity2',
    'ÖVERFLÖD ENTITY XXR': 'entityxxr',
    'OVERFLOD ENTITY XXR': 'entityxxr',
    'ÖVERFLÖD AUTARCH HYPERCAR': 'autarch',
    'OVERFLOD AUTARCH HYPERCAR': 'autarch',
    'LAMBORGHINI URUS 1016': '1016urus',
    'RAM 1500 TRX GHOUL': '1500ghoul',
    'GROTTI TURISMO HP': '09turishp',
    'PFISTER NEON CONCEPT': 'pfister',
    'OCELOT PARIAH SUPER SPORT': 'pariah',
    'PROGEN T20 HYPERCAR': 't20',
    'PEGASSI TORERO XO': 'torero2',
    'BUGATTI CHIRON SPORT': 'chiron',
    'BUGATTI DIVO HYPERCAR': 'divo',
    'VYSSER NEO HYPERCAR': 'neo',
    'ENTITYXF': 'entityxf',
    'ADDER': 'adder',
    'TEMPESTA': 'tempesta',
    'THRAX': 'thrax',
    'KRIEGER': 'krieger',
    'FURIA': 'furia',
    'ITALIRSX': 'italirsx'
  };
  const spawnCode = LUXURY_TO_SPAWN[raw] || raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `https://api.staff.gta.ctgaming.fr:2096/uploads/vehicle-screenshots/${encodeURIComponent(spawnCode)}.webp`;
}

function resolveSuitePhotoUrl(suiteName, customMediaUrls = null) {
  if (customMediaUrls) {
    try {
      if (typeof customMediaUrls === 'string' && customMediaUrls.startsWith('[')) {
        const arr = JSON.parse(customMediaUrls);
        if (arr && arr[0] && (String(arr[0]).startsWith('http') || String(arr[0]).startsWith('data:image/'))) {
          return arr[0];
        }
      } else if (typeof customMediaUrls === 'string' && (customMediaUrls.startsWith('http') || customMediaUrls.startsWith('data:image/'))) {
        return customMediaUrls;
      } else if (Array.isArray(customMediaUrls) && customMediaUrls[0]) {
        return customMediaUrls[0];
      }
    } catch (e) {}
  }
  const sUpper = String(suiteName || '').toUpperCase();
  const baseUrl = (typeof config !== 'undefined' && config.SITE_URL) ? config.SITE_URL : 'https://richman-estate.vercel.app';
  if (sUpper.includes('VILLA')) {
    return `${baseUrl}/assets/hotel/02_piscine_jour.jpg`;
  }
  if (sUpper.includes('PENTHOUSE')) {
    return `${baseUrl}/assets/hotel/03_panoramique_jour.jpg`;
  }
  return `${baseUrl}/assets/hotel/01_facade_jour.jpg`;
}

module.exports = {
  formatLuxuryCarName,
  resolveVehiclePhotoUrl,
  resolveSuitePhotoUrl
};
