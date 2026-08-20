/**
 * Richman Discord Bot — Vehicle Formatting & Resolution Helpers
 */

let config = null;
try {
  config = require('../config/constants');
} catch (e) {}

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

function formatPrice(rawPrice, defaultSuffix = ' / j') {
  if (rawPrice === undefined || rawPrice === null) return 'Sur devis';
  const str = String(rawPrice).trim();
  if (!str || str.toLowerCase() === 'sur devis' || str.toLowerCase() === 'devis' || str === '0') return 'Sur devis';

  // Si déjà formaté avec symbole et/ou unité
  if (/\d+[\s\u202F\u00A0]*[€$]/i.test(str)) {
    const numMatch = str.match(/[\d\s\u202F\u00A0]+/);
    if (numMatch) {
      const cleanNum = parseInt(numMatch[0].replace(/[\s\u202F\u00A0]/g, ''), 10);
      if (!isNaN(cleanNum)) {
        const formattedNum = cleanNum.toLocaleString('fr-FR');
        const unitMatch = str.match(/\/\s*(j|jour|nuit|semaine|mois)/i);
        const unit = unitMatch ? ` / ${unitMatch[1].toLowerCase() === 'jour' ? 'j' : unitMatch[1].toLowerCase()}` : (str.includes('/') ? '' : defaultSuffix);
        const currency = str.includes('$') ? '$' : '€';
        return `${formattedNum} ${currency}${unit}`.trim();
      }
    }
    return str;
  }

  // Nombre pur
  const num = parseInt(str.replace(/[^0-9]/g, ''), 10);
  if (!isNaN(num) && num > 0) {
    return `${num.toLocaleString('fr-FR')} €${defaultSuffix}`;
  }

  return str;
}

function getVehicleEmoji(carName, displayClass = '', customSpecs = '') {
  const cUpper = String(displayClass || '').toUpperCase();
  const nameLower = String(carName || '').toLowerCase();
  const specsLower = typeof customSpecs === 'string' ? customSpecs.toLowerCase() : '';

  if (cUpper.includes('MOTO') || cUpper.includes('CYCLE') || cUpper.includes('BIKE') || nameLower.includes('moto') || specsLower.includes('moto')) return '🏍️';
  if (cUpper.includes('BOAT') || cUpper.includes('BATEAU') || nameLower.includes('boat') || nameLower.includes('bateau')) return '🛥️';
  if (cUpper.includes('HELI') || nameLower.includes('heli') || nameLower.includes('helico')) return '🚁';
  if (cUpper.includes('PLANE') || cUpper.includes('AVION') || nameLower.includes('plane') || nameLower.includes('avion')) return '✈️';
  return '🏎️';
}

function getSuiteEmoji(suiteName = '', category = '') {
  const sUpper = String(suiteName || '').toUpperCase();
  const cUpper = String(category || '').toUpperCase();
  if (sUpper.includes('VILLA') || cUpper.includes('VILLA')) return '🏰';
  if (sUpper.includes('PENTHOUSE') || cUpper.includes('PENTHOUSE')) return '🌆';
  return '🏨';
}

function resolveVehiclePhotoUrl(carName, customSpecs = null) {
  if (customSpecs) {
    try {
      let meta = null;
      if (typeof customSpecs === 'object' && customSpecs !== null) {
        meta = customSpecs;
      } else if (typeof customSpecs === 'string') {
        if (customSpecs.startsWith('{')) {
          meta = JSON.parse(customSpecs);
        } else if (customSpecs.startsWith('http://') || customSpecs.startsWith('https://')) {
          return customSpecs.trim();
        }
      }
      if (meta) {
        const rawMedia = meta.media_url || meta.media_urls;
        if (rawMedia) {
          if (Array.isArray(rawMedia) && rawMedia[0] && String(rawMedia[0]).startsWith('http')) {
            return rawMedia[0];
          }
          if (typeof rawMedia === 'string') {
            if (rawMedia.startsWith('[')) {
              const arr = JSON.parse(rawMedia);
              if (arr && arr[0] && String(arr[0]).startsWith('http')) return arr[0];
            } else if (rawMedia.startsWith('http')) {
              return rawMedia.trim();
            }
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
  formatPrice,
  getVehicleEmoji,
  getSuiteEmoji,
  resolveVehiclePhotoUrl,
  resolveSuitePhotoUrl
};
