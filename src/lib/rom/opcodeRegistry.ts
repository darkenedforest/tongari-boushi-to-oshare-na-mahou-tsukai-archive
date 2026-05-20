// Port of the project's opcode registry — the single source of truth for
// how inline CMD opcodes render as tags in the translator-facing text.
//
// Source: src/translator/opcode_registry.py in the main translation repo
// (step-075 cataloguing, kept up to date through step-261). Anything not
// in the table falls back to [OP_NNNN] so unknown opcodes still survive
// into the rendered text.

/** opcode (15-bit) -> tag name (uppercase). Args are appended as :A:B:C... */
export const OPCODE_TAG_NAMES: Record<number, string> = {
  // Text substitutions (user-confirmed)
  0x01f4: 'PLAYER_NAME',
  0x0221: 'PLAYER_NAME_VAR',
  0x01f7: 'NPC',
  0x01f8: 'SCHOOL_NAME',
  0x01fb: 'ITEM',
  0x01f5: 'GUEST',
  0x01ff: 'PARTICLE',
  0x0205: 'CHOICES',
  0x0206: 'CHOICE',
  0x0000: 'COLOR',
  0x0013: 'MENU',
  // NPC personality data substitutions
  0x0202: 'NPC_DAT',
  0x0212: 'NPC_NAME',
  0x000c: 'AUTO_ADVANCE',
  // Letter template slots — msg98 family lives here
  0x0230: 'LETTER_ADDRESSEE',
  0x0231: 'LETTER_SIG',
  // Rumor / gossip template
  0x0213: 'RUMOR_PLACE',
  0x0214: 'RUMOR_VERB_PRE',
  0x0215: 'RUMOR_VERB',
  0x0217: 'TREND_SLOT_A',
  0x0218: 'RUMOR_LOC_B',
  0x021a: 'RUMOR_VERB_B',
  // Trend cluster
  0x0228: 'TREND_PERSON',
  0x0229: 'TREND_PRODUCT',
  0x022a: 'TREND_RANK',
  0x022b: 'TREND_ITEM_SLOT',
  // Shop cluster
  0x021c: 'ITEM_DESC',
  0x021d: 'PRICE_VALUE',
  0x0227: 'SHOP_EARNINGS',
  0x024e: 'SHOP_QTY_OR_DAYS',
  0x0208: 'SHOP_NAME_REF',
  0x024b: 'OUTFIT_COUNT',
  // Fair cluster
  0x023a: 'FAIR_MONTH',
  0x023b: 'FAIR_TYPE',
  0x023e: 'GIFT_ITEM',
  // Fashion / show cluster
  0x0241: 'IMAGE_ADJECTIVE',
  0x0245: 'COLOR_ADJ',
  0x0246: 'IMAGE_ADJ',
  0x0247: 'OP_0247',
  0x0248: 'SHOW_THEME_CURRENT',
  0x0249: 'SHOW_COLOR',
  0x024a: 'SHOW_THEME',
  0x0244: 'FAIR_GRID_CELL',
  // Idol / location / student
  0x023d: 'IDOL_NAME',
  0x023c: 'LOCATION_NAME',
  0x0204: 'STUDENT_NAME',
  // Other content slots
  0x0203: 'OTHER_PERSON',
  // Menu-option markers
  0x0010: 'OP_0010',
  0x0011: 'OP_0011',
  0x0012: 'OP_0012',
  0x002b: 'CLASS_MENU_START',
  // End-of-line sentinels
  0x004a: 'OP_004A',
  0x004c: 'OP_004C',
  0x004f: 'OP_004F',
  0x0020: 'OP_0020',
  0x0021: 'OP_0021',
  0x0054: 'OP_0054',
  // State / SFX toggles
  0x0001: 'OP_0001',
  0x0015: 'SFX_TRIGGER',
  0x003a: 'SFX_VALUE',
  0x0053: 'OP_0053',
  0x0055: 'OP_0055',
  0x0060: 'EMPHASIS_NOD',
  0x0064: 'OP_0064',
  // Compound glyph pair
  0x001a: 'OP_001A',
  0x001b: 'OP_001B',
  // Preamble-dominant
  0x0016: 'EXPR',
  0x0017: 'TEXTBOX',
  0x0018: 'SPEAKER',
  0x0037: 'DIALOG_START',
  // Genuinely rare / unknown
  0x0209: 'OP_0209',
  0x0031: 'OP_0031',
};

export function tagName(opcode: number): string {
  const named = OPCODE_TAG_NAMES[opcode];
  if (named !== undefined) return named;
  return `OP_${opcode.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function formatTag(opcode: number, args: number[]): string {
  const name = tagName(opcode);
  if (!args || args.length === 0) return `[${name}]`;
  return `[${name}:${args.join(':')}]`;
}
