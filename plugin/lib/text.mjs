const ENTITY_RE = /(?:[\w./\\-]+\.(?:js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|json|yaml|yml|md|sh|toml))\b|\b\w+(?:\(\))/g;

const LEAD_IN_RE = /^(?:here(?:'s| is| are)|let me|i'll |i will |i'm going to|now,? let me|so,? here|ok(?:ay)?,? (?:so|let|here|now))/i;

const _wordRegexCache = new Map();

export function stripMarkdown(text) {
  if (!text || typeof text !== 'string') return text;

  let s = text;

  s = s.replace(/^```[^\n]*\n?/gm, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^(\s*)[-*]\s*\[[ x]\]\s*/gm, '$1');
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1');
  s = s.replace(/^(\s*)\d+\.\s+/gm, '$1');
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');
  s = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}]+/gu, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map(l => l.trimEnd()).join('\n').trim();

  return s;
}

function stripLeadIns(text) {
  if (!text) return text;
  let result = text;

  const lines = result.split('\n');
  const firstLine = lines[0]?.trim() || '';
  if (firstLine.length < 80 && /:\s*$/.test(firstLine) && lines.length > 1) {
    const rest = lines.slice(1).join('\n').trim();
    if (rest) result = rest;
  }

  const sentenceEnd = result.match(/^(.+?[.!?])\s+(.+)/s);
  if (sentenceEnd) {
    const first = sentenceEnd[1].trim();
    if (first.length < 80 && isLeadIn(first)) {
      result = sentenceEnd[2].trim();
    }
  }

  return result;
}

function isLeadIn(sentence) {
  return LEAD_IN_RE.test(sentence);
}

export function splitSentences(text) {
  const units = [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());

  for (const para of paragraphs) {
    const lines = para.split('\n').map(l => l.trim()).filter(l => l);
    const isBulletList = lines.every(l => /^[-*•]\s/.test(l) || l === '');

    if (isBulletList) {
      for (const line of lines) {
        const content = line.replace(/^[-*•]\s+/, '').trim();
        if (content) units.push(content);
      }
    } else {
      const normalized = para.replace(/\s+/g, ' ').trim();
      const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim());
      if (sentences.length > 0) {
        units.push(...sentences);
      } else if (normalized) {
        units.push(normalized);
      }
    }
  }

  if (units.length === 0 && text.trim()) {
    units.push(text.replace(/\s+/g, ' ').trim());
  }

  return units;
}

function getWordRegex(words) {
  const key = words.join('|');
  if (!_wordRegexCache.has(key)) {
    const alternation = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    _wordRegexCache.set(key, new RegExp(`\\b(?:${alternation})\\b`, 'gi'));
  }
  return _wordRegexCache.get(key);
}

function scoreSentence(sentence, config) {
  let score = 0;

  const actionWords = config.actionWords || [];
  if (actionWords.length > 0) {
    const regex = getWordRegex(actionWords);
    regex.lastIndex = 0;
    const matches = sentence.match(regex);
    if (matches) score += matches.length;
  }

  const reasoningWords = config.reasoningWords || [];
  if (reasoningWords.length > 0) {
    const regex = getWordRegex(reasoningWords);
    regex.lastIndex = 0;
    const matches = sentence.match(regex);
    if (matches) score += matches.length * 0.8;
  }

  const entityMatches = sentence.match(ENTITY_RE);
  if (entityMatches) score += entityMatches.length * 0.5;

  return score;
}

export function extractiveSummarize(text, config) {
  const cleaned = stripLeadIns(text);
  const sentences = splitSentences(cleaned);

  if (sentences.length === 0) return text;
  if (sentences.length <= config.maxSummarySentences) return sentences.join(' ');

  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: scoreSentence(sentence, config)
  }));

  const selected = new Set([0]);

  const rest = scored.filter(s => s.index !== 0);
  rest.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  for (const s of rest) {
    if (selected.size >= config.maxSummarySentences) break;
    selected.add(s.index);
  }

  return scored
    .filter(s => selected.has(s.index))
    .sort((a, b) => a.index - b.index)
    .map(s => s.sentence)
    .join(' ');
}
