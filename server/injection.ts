import type { InjectionScanResult } from './types.ts';

interface InjectionRule {
  name: string;
  category: string;
  pattern: RegExp;
  confidence: number;
}

const INJECTION_RULES: InjectionRule[] = [
  {
    name: 'INSTRUCTION_OVERRIDE_EN',
    category: 'Instruction Override',
    pattern: /\b(ignore|disregard|forget|override|bypass|skip)\s+(all\s+)?(previous|prior|above|system|safety|security|airlock|dlp)\s+(instructions|rules|prompts|guardrails|policies|filters)\b/i,
    confidence: 0.98,
  },
  {
    name: 'SECRET_EXTRACTION_EN',
    category: 'Secret Exfiltration',
    pattern: /\b(reveal|print|show|dump|output|leak|expose|tell\s+me)\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions|api\s*keys?|secrets?|credentials?|env(\s+variables)?|placeholder\s+map)\b/i,
    confidence: 0.96,
  },
  {
    name: 'JAILBREAK_PERSONA',
    category: 'Jailbreak / Role Override',
    pattern: /\b(you\s+are\s+now\s+DAN|developer\s+mode\s+enabled|act\s+as\s+an?\s+unrestricted|jailbreak\s+mode|do\s+anything\s+now)\b/i,
    confidence: 0.95,
  },
  {
    name: 'DELIMITER_SMUGGLING',
    category: 'Token / Delimiter Smuggling',
    pattern: /(<\|im_start\|>\s*system|<\|system\|>|\[\/?SYSTEM\]|###\s*SYSTEM\s*OVERRIDE)/i,
    confidence: 0.97,
  },
  {
    name: 'BANGLISH_INJECTION',
    category: 'Banglish Instruction Override',
    pattern: /\b(ager\s+(sob|shob)\s+(niyom|niom|instruction|rules?)\s+(vule|bhule)\s+jao|purber\s+nirdesh\s+batil|system\s+prompt\s+dekhao|gopon\s+(tothyo|tottho|key|secret)\s+(dao|dekhao)|security\s+bypass\s+koro)\b/i,
    confidence: 0.94,
  },
  {
    name: 'BANGLA_INJECTION',
    category: 'Bangla Instruction Override',
    pattern: /(পূর্বের\s+(সব\s+)?নির্দেশ\s*(ভুলে\s*যাও|বাতিল\s*করো)|সব\s+নিয়ম\s+বাতিল|সিস্টেম\s+প্রম্পট\s+দেখাও|গোপন\s+(তথ্য|কী|পাসওয়ার্ড)\s+(দাও|দেখাও))/u,
    confidence: 0.95,
  },
];

/**
 * Local in-memory Prompt-Injection Scanner.
 * Runs synchronously before any external AI call.
 */
export function scanPromptInjection(
  prompt: string,
  options: { enabled: boolean }
): InjectionScanResult {
  if (!options.enabled) {
    return { blocked: false, confidence: 0 };
  }

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(prompt)) {
      return {
        blocked: true,
        ruleName: rule.name,
        category: rule.category,
        confidence: rule.confidence,
      };
    }
  }

  return { blocked: false, confidence: 0 };
}
