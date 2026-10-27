// What kind of wearable a product is, and how the AI should place it.
// Detection reads the product type, tags, title and handle. A product metafield (custom.tryon_category) always wins.
// Add a category here and every store gets it. `include` = phrases that identify it, `exclude` = phrases that rule it out
// (so "beard oil" is not a beard and "wig stand" is not a wig). Phrases match whole words, ignoring case and punctuation.

export const CATEGORIES = {
  hair: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear, front-facing photo with your whole head and hair in view.',
    keepFace: true,
    change: 'large',
    label: 'wig / hair',
    placement:
      'wearing this hair product (wig, hair extensions, bundles, braids or twists exactly as shown) as a complete, natural-looking head of hair that replaces their visible hair, with a believable hairline and parting',
    include: [
      'wig', 'wigs', 'lace front', 'lace frontal', 'lace closure', 'hair closure', 'hair extension', 'hair extensions', 'clip in', 'clip ins',
      'tape in', 'weave', 'weaves', 'hair bundle', 'hair bundles', 'bundles', 'braid', 'braids', 'braiding', 'crochet hair', 'passion twist',
      'yanky twist', 'twist braids', 'locs', 'dreadlocks', 'ponytail', 'human hair', 'remy', 'toupee', 'hairpiece', 'hair piece', 'body wave',
      'loose wave', 'deep wave', 'kinky straight', 'curly hair', 'curly wig', 'pixie curl', 'jerry curl', 'yaki', 'balayage', 'marley',
      'brazilian wool', 'wool braid',
    ],
    exclude: ['wig stand', 'wig cap', 'wig glue', 'wig grip', 'wig tape', 'shampoo', 'conditioner', 'hair oil', 'serum', 'spray', 'mousse', 'brush', 'comb', 'bonnet', 'eyelash', 'lash', 'gift card'],
    lengthAware: true,
  },
  hat: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear, front-facing photo of your head, with your hair and forehead visible.',
    keepFace: true,
    change: 'large',
    label: 'hat / cap',
    placement:
      'wearing this hat or cap on their head, sitting at a natural angle and the correct size for their head, with their hair showing naturally around it and a soft realistic shadow on the forehead',
    include: ['hat', 'hats', 'cap', 'caps', 'beanie', 'beanies', 'fedora', 'beret', 'bucket hat', 'snapback', 'trucker', 'visor', 'turban', 'kufi', 'cowboy hat', 'sun hat', 'baseball cap', 'helmet'],
    exclude: ['hat box', 'hatbox', 'hat rack', 'hat stand', 'hat clip', 'bottle cap', 'wig cap', 'lens cap', 'gift card'],
  },
  beard: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear, front-facing photo with your whole face and jaw visible.',
    keepFace: false,
    change: 'small',
    label: 'beard / moustache',
    placement:
      'with this beard or moustache on their face exactly as shown, following the jawline and upper lip naturally, with a believable growth edge on the cheeks and matched skin tone and lighting',
    include: ['beard', 'beards', 'moustache', 'mustache', 'goatee', 'sideburns', 'stubble'],
    exclude: ['oil', 'balm', 'trimmer', 'shampoo', 'comb', 'brush', 'wash', 'serum', 'cream', 'wax', 'kit', 'razor', 'gift card'],
  },
  glasses: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear, front-facing photo with both eyes visible and no other glasses on.',
    keepFace: false,
    change: 'small',
    label: 'glasses / sunglasses',
    placement:
      'wearing these glasses on their face, correct scale, resting on the bridge of the nose and over the ears, with realistic lens tint and reflections as in the product photo',
    include: ['glasses', 'eyeglasses', 'sunglasses', 'spectacles', 'eyewear', 'goggles', 'optical frames', 'glasses frames'],
    exclude: ['case', 'cloth', 'cleaner', 'chain', 'strap', 'gift card'],
  },
  earrings: {
    needs: 'ears', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a photo where your ear (ideally both) is visible and not covered by hair.',
    keepFace: true,
    change: 'small',
    label: 'earrings',
    placement: 'wearing these earrings on their ears, correct scale, hanging naturally, shown on whichever ears are visible. If no ear is visible in image 1, do not add one: reply with a short text explanation instead of an image',
    include: ['earring', 'earrings', 'ear ring', 'studs', 'hoops', 'ear cuff', 'ear cuffs', 'jhumka', 'jhumkas', 'drop earrings'],
    exclude: ['gift card', 'backs', 'organizer', 'organiser'],
  },
  necklace: {
    needs: 'neck', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a photo that shows your neck and collarbones, with your hair moved aside.',
    keepFace: true,
    change: 'small',
    label: 'necklace',
    placement: 'wearing this necklace around their neck, hanging naturally on the collarbones and chest at its true size; if the neck is not visible in image 1, do not invent one: reply with a short text explanation instead of an image',
    include: ['necklace', 'necklaces', 'pendant', 'pendants', 'choker', 'chain', 'chains', 'locket', 'mangalsutra'],
    exclude: ['gift card', 'box', 'stand', 'organizer', 'organiser', 'cleaner'],
  },
  headwear: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear photo of your head with your hair visible.',
    keepFace: true,
    change: 'small',
    label: 'headband / hair accessory',
    placement: 'wearing this headband or hair accessory in their hair, placed where it is normally worn, at its true size',
    include: ['headband', 'headbands', 'hair clip', 'hair clips', 'claw clip', 'hair band', 'scrunchie', 'scrunchies', 'hair pin', 'hairpin', 'barrette', 'bandana', 'hair tie', 'tiara', 'crown', 'hair accessory', 'hair accessories'],
    exclude: ['gift card'],
  },
  wrist: {
    needs: 'wrist', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear photo of your wrist and hand, palm down or facing the camera, with the sleeve pushed back. A face photo will not work for this product.',
    keepFace: false,
    change: 'small',
    label: 'watch / bracelet',
    placement:
      'wearing this watch or bracelet on their wrist, correctly sized and turned the way it is normally worn, with the face, clasp or charms as shown in the product photo and realistic shadows on the skin. If no wrist is visible in image 1, do not add one: reply with a short text explanation instead of an image',
    include: ['watch', 'watches', 'smartwatch', 'wristwatch', 'bracelet', 'bracelets', 'bangle', 'bangles', 'cuff bracelet', 'wristband', 'kada'],
    exclude: ['watch band', 'watch strap', 'watch box', 'watch case', 'watch winder', 'watch repair', 'gift card', 'charger'],
  },
  ring: {
    needs: 'hand', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a clear photo of your hand with your fingers visible and spread slightly. A face photo will not work for this product.',
    keepFace: false,
    change: 'small',
    label: 'ring',
    placement:
      'wearing this ring on the correct finger of their hand, at its true size, with the stone and band exactly as shown and realistic shadows. If no hand is visible in image 1, do not add one: reply with a short text explanation instead of an image',
    include: ['ring', 'rings', 'engagement ring', 'wedding band', 'signet ring', 'band ring'],
    exclude: ['ring light', 'key ring', 'keyring', 'napkin ring', 'ring box', 'ring holder', 'ring size', 'teething ring', 'ring stand', 'gift card', 'bearing'],
  },
  scarf: {
    needs: 'neck', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a photo that shows your head, neck and shoulders.',
    keepFace: true,
    change: 'large',
    label: 'scarf / shawl',
    placement: 'wearing this scarf or shawl the way it is normally worn (around the neck or draped over the shoulders), with realistic folds',
    include: ['scarf', 'scarves', 'shawl', 'stole', 'dupatta', 'hijab'],
    exclude: ['gift card', 'pin', 'ring', 'holder'],
  },
  makeup: {
    needs: 'face', // what the shopper's photo must show: face | ears | neck | wrist | hand (checked in the browser before any AI call)
    photoHint: 'Use a bright, front-facing photo of your bare face.',
    keepFace: false,
    change: 'none',
    label: 'makeup shade',
    placement: 'wearing this makeup product applied the way it is meant to be used (lipstick on the lips, blush on the cheeks, eyeshadow on the lids), in exactly the shade shown, looking natural',
    include: ['lipstick', 'lip gloss', 'lip stain', 'lip liner', 'blush', 'eyeshadow', 'eye shadow', 'eyeliner', 'foundation', 'bronzer', 'highlighter'],
    exclude: ['brush', 'sponge', 'remover', 'bag', 'case', 'gift card'],
  },
};

const norm = (x) => ` ${String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const has = (hay, phrase) => hay.includes(` ${norm(phrase).trim()} `);

export function categoryIds() {
  return Object.keys(CATEGORIES);
}

/**
 * Decide the category of a normalized product.
 * Returns { id, by }: by = 'metafield' | 'type' | 'name' | 'none'. id is null when the product is not something to try on.
 * Words in the product type and tags count more than words in the title.
 */
export function classify(product, hint) {
  if (hint && CATEGORIES[hint]) return { id: hint, by: 'metafield' };
  const typeText = norm([product.type, ...(product.tags || [])].join(' '));
  const nameText = norm(`${product.title || ''} ${String(product.handle || '').replace(/-/g, ' ')}`);
  const all = typeText + nameText;
  let best = null;
  let bestScore = 0;
  let bestBy = 'none';
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (cat.exclude.some((p) => has(all, p))) continue;
    let score = 0;
    let by = 'name';
    for (const p of cat.include) {
      const words = norm(p).trim().split(' ').length;
      if (has(typeText, p)) { score = Math.max(score, 3 * words); by = 'type'; }
      else if (has(nameText, p)) score = Math.max(score, 2 * words);
    }
    if (score > bestScore) { best = id; bestScore = score; bestBy = by; }
  }
  return { id: best, by: best ? bestBy : 'none' };
}
