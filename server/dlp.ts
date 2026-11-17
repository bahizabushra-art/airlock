import { db } from './db.ts';
import type { DlpScanResult, DlpSensitivity, PiiCategory, RedactionMeta } from './types.ts';

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0',
  '১': '1',
  '২': '2',
  '৩': '3',
  '৪': '4',
  '৫': '5',
  '৬': '6',
  '৭': '7',
  '৮': '8',
  '৯': '9',
};

/**
 * 1:1 character-length-preserving normalization of Bengali digits (০-৯) to ASCII (0-9).
 * Preserves exact string indices so captured spans match the original input verbatim.
 */
export function normalizeBengaliDigits(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    out += BENGALI_DIGIT_MAP[ch] ?? ch;
  }
  return out;
}

function detectLanguageHint(snippet: string): 'bangla' | 'banglish' | 'english' {
  if (/[\u0980-\u09FF]/.test(snippet)) return 'bangla';
  if (/\b(amar|amader|tumi|apnar|apni|nam|naame|basha|thana|zila|jila|taka|nogod|ar|er|koro|hobe|nai|ache)\b/i.test(snippet)) {
    return 'banglish';
  }
  return 'english';
}

function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (Number.isNaN(n)) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

interface CandidateMatch {
  start: number;
  end: number;
  category: PiiCategory;
  priority: number;
}

const PRIORITY: Record<PiiCategory, number> = {
  SECRET: 100,
  CARD: 95,
  NID: 90,
  MFS: 85,
  ACCOUNT: 80,
  TIN: 75,
  PASSPORT: 70,
  EMAIL: 65,
  PHONE: 60,
  ADDRESS: 50,
  PERSON: 45,
};

function addRegexMatches(
  candidates: CandidateMatch[],
  text: string,
  regex: RegExp,
  category: PiiCategory,
  groupIndex = 0,
  validator?: (matched: string) => boolean,
  priorityOverride?: number
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const value = match[groupIndex];
    if (!value) {
      if (match.index === regex.lastIndex) regex.lastIndex++;
      continue;
    }
    if (validator && !validator(value)) continue;

    let start = match.index;
    if (groupIndex > 0) {
      const groupOffset = match[0].indexOf(value);
      if (groupOffset >= 0) {
        start = match.index + groupOffset;
      }
    }
    const end = start + value.length;
    candidates.push({
      start,
      end,
      category,
      priority: priorityOverride ?? PRIORITY[category],
    });
  }
}

/**
 * Local, in-memory, fail-closed DLP inspection engine for Bangla, Banglish, and English.
 * Throws if engine is disabled so callers enforce HTTP 503 Fail-Closed.
 */
export function inspectAndRedact(
  rawText: string,
  options: { dlpEnabled: boolean; sensitivity: DlpSensitivity },
  existingMap?: Map<string, string>
): DlpScanResult {
  if (!options.dlpEnabled) {
    throw new Error('DLP_ENGINE_UNAVAILABLE: Local DLP inspection layer is disabled or offline.');
  }

  const normalized = normalizeBengaliDigits(rawText);
  const candidates: CandidateMatch[] = [];

  // 1. Secrets / API Keys / Tokens / Passwords
  addRegexMatches(
    candidates,
    normalized,
    /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    'SECRET'
  );
  addRegexMatches(
    candidates,
    normalized,
    /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
    'SECRET'
  );
  addRegexMatches(
    candidates,
    normalized,
    /(?:password|passcode|pin|secret|পাসওয়ার্ড|পিন)\s*(?:is|holo|হলো|:|=)?\s*([^\s,;]{4,32})/giu,
    'SECRET',
    1
  );

  // 2. Payment Cards (16 digits with optional separators, Luhn validated in balanced mode or 4x4 groups)
  addRegexMatches(
    candidates,
    normalized,
    /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    'CARD',
    0,
    (m) => {
      const digits = m.replace(/\D/g, '');
      return options.sensitivity === 'strict' ? digits.length === 16 : luhnCheck(digits);
    }
  );

  // 3. Bangladesh NID (6-17 digits with explicit NID/ID-number context; 10/13/17 digits standalone in strict mode)
  addRegexMatches(
    candidates,
    normalized,
    /(?:nid|national\s*id|voter\s*id|smart\s*card|\bid\s*(?:no|number|num)\b|জাতীয়\s*পরিচয়পত্র|জাতীয়\s*পরিচয়পত্র|পরিচয়পত্র|পরিচয়পত্র|এনআইডি|ভোটার\s*আইডি|আইডি\s*(?:নং|নম্বর|নাম্বার))(?:\s*(?:no|number|num|নং|নম্বর|নাম্বার|is|holo|হলো|:|=))?\s*[:#-]?\s*(\d{6,17})\b/giu,
    'NID',
    1,
    undefined,
    115
  );
  // Strict mode also catches standalone 10, 13, or 17 digit NID numbers (lower priority than contextual phone/account)
  if (options.sensitivity === 'strict') {
    addRegexMatches(
      candidates,
      normalized,
      /(?<!\d)(\d{10}|\d{13}|\d{17})(?!\d)/g,
      'NID',
      1,
      undefined,
      40
    );
  }

  // 4. MFS Wallets (bKash, Nagad, Rocket, Upay) - Bangla, Banglish, English
  addRegexMatches(
    candidates,
    normalized,
    /(?:bkash|bKash|nagad|nogod|rocket|upay|বিকাশ|নগদ|রকেট|উপায়)(?:\s*(?:no|number|wallet|account|নং|নম্বর|অ্যাকাউন্ট|is|holo|:|=))?\s*[:#-]?\s*((?:\+?88)?01[3-9]\d{8})\b/giu,
    'MFS',
    1
  );

  // 5. Bank Account / Routing Numbers - Context-aware Bangla, Banglish, English
  addRegexMatches(
    candidates,
    normalized,
    /(?:bank\s*account|account\s*(?:no|number|num)?|a\/c|acc\s*no|অ্যাকাউন্ট(?:\s*নং|\s*নম্বর)?|হিসাব(?:\s*নং|\s*নম্বর)?)(?:\s*(?:is|holo|হলো|:|=))?\s*[:#-]?\s*(\d{8,18})\b/giu,
    'ACCOUNT',
    1
  );

  // 6. Tax ID (e-TIN 12 digits) & Passport (BD 1-2 letters + 7 digits)
  addRegexMatches(
    candidates,
    normalized,
    /(?:e-?tin|tin|টিআইএন)(?:\s*(?:no|number|নং|নম্বর|is|holo|:|=))?\s*[:#-]?\s*(\d{12})\b/giu,
    'TIN',
    1
  );
  addRegexMatches(
    candidates,
    normalized,
    /(?:passport|পাসপোর্ট)(?:\s*(?:no|number|নং|নম্বর|is|holo|:|=))?\s*[:#-]?\s*([A-Z]{1,2}\d{7})\b/giu,
    'PASSPORT',
    1
  );

  // 7. Email addresses
  addRegexMatches(
    candidates,
    normalized,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    'EMAIL'
  );

  // 8. Phone numbers (Bangladeshi mobile +8801X / 01X and international E.164 or contextual 7-13 digits)
  addRegexMatches(
    candidates,
    normalized,
    /(?<!\d)(?:\+?88[-\s]?)?01[3-9]\d{2}[-\s]?\d{6}(?!\d)/g,
    'PHONE',
    0,
    undefined,
    85
  );
  addRegexMatches(
    candidates,
    normalized,
    /(?:phone|mobile|cell|contact|call|ফোন|মোবাইল|নম্বর|নাম্বার)(?:\s*(?:no|number|num|নং|নম্বর|নাম্বার|is|holo|হলো|:|=))?\s*[:#-]?\s*(\+?\d[\d\s-]{6,16}\d)/giu,
    'PHONE',
    1,
    (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15;
    },
    88
  );

  // 9. Contextual Address (Bangla, Banglish, English)
  addRegexMatches(
    candidates,
    rawText,
    /(?:address|basha|thikana|ঠিকানা|বাসা)[ \t]*(?:is|holo|হলো|:|=)[ \t]*([^\n.;!?]{6,80})/giu,
    'ADDRESS',
    1,
    (m) => !/^[*_\s]*\[[A-Z]+_\d+\][*_\s]*$/.test(m)
  );

  // 10. Contextual Person Names (Bangla, Banglish, English)
  addRegexMatches(
    candidates,
    rawText,
    /(?:my\s+name\s+is|amar\s+nam|amar\s+name|client\s+name|applicant\s+name|আমার\s+নাম)[ \t]*(?:is|holo|হলো|:|=)?[ \t]*([A-Z\u0980-\u09FF][A-Za-z\u0980-\u09FF.'-]+(?:[ \t]+[A-Z\u0980-\u09FF][A-Za-z\u0980-\u09FF.'-]+){0,3})/giu,
    'PERSON',
    1,
    (m) => !/^[*_\s]*\[[A-Z]+_\d+\][*_\s]*$/.test(m)
  );
  addRegexMatches(
    candidates,
    rawText,
    /(?:^|[\n,;])[ \t]*(?:name|nam|নাম)[ \t]*(?::|=|\bis\b|\bholo\b|হলো)[ \t]*([A-Z\u0980-\u09FF][A-Za-z\u0980-\u09FF.'-]+(?:[ \t]+[A-Z\u0980-\u09FF][A-Za-z\u0980-\u09FF.'-]+){0,3})/giu,
    'PERSON',
    1,
    (m) => !/^[*_\s]*\[[A-Z]+_\d+\][*_\s]*$/.test(m)
  );

  // Resolve overlapping spans: higher priority first, then longer span, then earlier start
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return a.start - b.start;
  });

  const accepted: CandidateMatch[] = [];
  for (const cand of candidates) {
    const overlaps = accepted.some((acc) => !(cand.end <= acc.start || cand.start >= acc.end));
    if (!overlaps) {
      accepted.push(cand);
    }
  }

  // Sort left-to-right for deterministic placeholder numbering
  accepted.sort((a, b) => a.start - b.start);

  const placeholderMap = new Map<string, string>();
  const reverseLookup = new Map<string, string>();
  const categoryCounters = new Map<PiiCategory, number>();
  const redactions: RedactionMeta[] = [];

  if (existingMap) {
    for (const [ph, orig] of existingMap.entries()) {
      placeholderMap.set(ph, orig);
      const m = /^\[([A-Z]+)_(\d+)\]$/.exec(ph);
      if (m) {
        const cat = m[1] as PiiCategory;
        const idx = Number(m[2]);
        reverseLookup.set(`${cat}::${orig}`, ph);
        categoryCounters.set(cat, Math.max(categoryCounters.get(cat) ?? 0, idx));
      }
    }
  }

  let sanitizedText = '';
  let cursor = 0;

  for (const span of accepted) {
    const originalValue = rawText.slice(span.start, span.end);
    let placeholder = reverseLookup.get(`${span.category}::${originalValue}`);

    if (!placeholder) {
      const nextIndex = (categoryCounters.get(span.category) ?? 0) + 1;
      categoryCounters.set(span.category, nextIndex);
      placeholder = `[${span.category}_${nextIndex}]`;
      placeholderMap.set(placeholder, originalValue);
      reverseLookup.set(`${span.category}::${originalValue}`, placeholder);
      redactions.push({
        placeholder,
        category: span.category,
        language: detectLanguageHint(rawText.slice(Math.max(0, span.start - 20), Math.min(rawText.length, span.end + 10))),
      });
    }

    sanitizedText += rawText.slice(cursor, span.start) + placeholder;
    cursor = span.end;
  }

  sanitizedText += rawText.slice(cursor);

  return {
    sanitizedText,
    placeholderMap,
    redactions,
    engineHealthy: true,
  };
}

/**
 * Replaces placeholders like [NID_1] back with their transient in-memory values.
 */
export function reidentifyText(text: string, placeholderMap: Map<string, string>): string {
  if (placeholderMap.size === 0 || !text) return text;
  let result = text;
  for (const [placeholder, original] of placeholderMap.entries()) {
    result = result.replaceAll(placeholder, original);
  }
  return result;
}

/**
 * Buffers partial `[CATEGORY_N]` bracket tokens across SSE chunks so placeholders split
 * across network/model boundaries are still cleanly re-identified in memory.
 */
export class StreamingReidentifier {
  private buffer = '';
  private readonly placeholderMap: Map<string, string>;

  constructor(placeholderMap: Map<string, string>) {
    this.placeholderMap = placeholderMap;
  }

  push(chunk: string): string {
    if (this.placeholderMap.size === 0) return chunk;
    this.buffer += chunk;

    const lastOpen = this.buffer.lastIndexOf('[');
    if (lastOpen === -1) {
      const out = reidentifyText(this.buffer, this.placeholderMap);
      this.buffer = '';
      return out;
    }

    const tail = this.buffer.slice(lastOpen);
    // If `[` has no matching `]` yet and looks like a placeholder prefix (<= 24 chars), hold it
    if (!tail.includes(']') && tail.length <= 24) {
      const safePrefix = this.buffer.slice(0, lastOpen);
      this.buffer = tail;
      return reidentifyText(safePrefix, this.placeholderMap);
    }

    const out = reidentifyText(this.buffer, this.placeholderMap);
    this.buffer = '';
    return out;
  }

  flush(): string {
    if (!this.buffer) return '';
    const out = reidentifyText(this.buffer, this.placeholderMap);
    this.buffer = '';
    return out;
  }
}

/**
 * Audits SQLite persisted tables (`messages`, `audit_logs`) to verify Zero-Persistence of raw PII.
 */
export function scanDatabaseForRawPii(): {
  clean: boolean;
  scannedMessages: number;
  scannedAuditLogs: number;
  findingsCount: number;
} {
  const messages = db.prepare('SELECT id, sanitized_content FROM messages').all() as Array<{
    id: string;
    sanitized_content: string;
  }>;
  const logs = db.prepare('SELECT id, sanitized_snippet FROM audit_logs').all() as Array<{
    id: string;
    sanitized_snippet: string;
  }>;

  let findingsCount = 0;

  for (const msg of messages) {
    const res = inspectAndRedact(msg.sanitized_content, { dlpEnabled: true, sensitivity: 'strict' });
    if (res.redactions.length > 0) findingsCount += res.redactions.length;
  }
  for (const log of logs) {
    const res = inspectAndRedact(log.sanitized_snippet, { dlpEnabled: true, sensitivity: 'strict' });
    if (res.redactions.length > 0) findingsCount += res.redactions.length;
  }

  return {
    clean: findingsCount === 0,
    scannedMessages: messages.length,
    scannedAuditLogs: logs.length,
    findingsCount,
  };
}
