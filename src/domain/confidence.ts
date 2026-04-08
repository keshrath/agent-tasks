// =============================================================================
// agent-tasks — Task confidence scoring
//
// Deterministic, heuristic quality score (0–100) for a task's title +
// description. Used as a claim-time gate so vague, one-line tasks don't
// silently consume an agent's context.
//
// No LLM calls — purely structural checks. The reasons array explains what
// pulled the score down so authors know how to improve the task.
// =============================================================================

export interface ConfidenceScore {
  /** 0–100, higher is more confident the task is actionable. */
  score: number;
  /** Human-readable bullet points explaining strengths and gaps. */
  reasons: string[];
}

export interface ConfidenceInput {
  title: string;
  description?: string | null;
}

// Tunables. Kept module-private; the gate threshold lives on GateConfig.
const TITLE_MIN_WORDS = 3;
const DESC_SHORT = 100;
const DESC_MEDIUM = 300;

// Detect a path-ish token (foo/bar.ts, foo\bar.ts, src/x.js:42).
const FILE_PATH_RE = /(?:^|[\s(`'"])[\w./\\-]+\.[a-zA-Z0-9]{1,8}(?::\d+)?(?=[\s)`'".,;]|$)/m;
// Detect a URL.
const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
// Markdown bullet or numbered list.
const LIST_RE = /(?:^|\n)\s*(?:[-*+]|\d+\.)\s+\S/;
// Markdown section header.
const HEADER_RE = /(?:^|\n)#{1,6}\s+\S/;
// Acceptance / expectation language.
const ACCEPTANCE_RE =
  /\b(acceptance|criteria|expect(?:ed|s)?|should|must|deliverable|done when)\b/i;
// Code fence.
const CODE_FENCE_RE = /```[\s\S]+?```|`[^`\n]+`/;

/**
 * Score a task's clarity. Pure function — no DB, no I/O.
 */
export function scoreTaskConfidence(input: ConfidenceInput): ConfidenceScore {
  const reasons: string[] = [];
  let score = 0;

  const title = (input.title ?? '').trim();
  const description = (input.description ?? '').trim();

  // ---- Title (max 20 points) ------------------------------------------------
  if (title.length > 0) {
    score += 10;
    const wordCount = title.split(/\s+/).filter(Boolean).length;
    if (wordCount >= TITLE_MIN_WORDS) {
      score += 10;
    } else {
      reasons.push(
        `Title has only ${wordCount} word(s); aim for ${TITLE_MIN_WORDS}+ that name an action and a target.`,
      );
    }
  } else {
    reasons.push('Title is empty.');
  }

  // ---- Description presence and length (max 35 points) ---------------------
  if (description.length === 0) {
    reasons.push('Description is empty — add context, motivation, or acceptance criteria.');
  } else {
    score += 10;
    if (description.length >= DESC_SHORT) {
      score += 10;
    } else {
      reasons.push(
        `Description is short (${description.length} chars); aim for at least ${DESC_SHORT}.`,
      );
    }
    if (description.length >= DESC_MEDIUM) {
      score += 15;
    }
  }

  // ---- Structural markers (max 25 points) ----------------------------------
  if (LIST_RE.test(description)) {
    score += 10;
  } else if (description.length > 0) {
    reasons.push('No bullet or numbered list — consider listing steps or requirements.');
  }
  if (HEADER_RE.test(description)) {
    score += 10;
  }
  if (CODE_FENCE_RE.test(description)) {
    score += 5;
  }

  // ---- Concrete references (max 15 points) ---------------------------------
  if (FILE_PATH_RE.test(description) || FILE_PATH_RE.test(title)) {
    score += 10;
  } else if (description.length > 0) {
    reasons.push('No file path referenced — point at a concrete location to anchor the work.');
  }
  if (URL_RE.test(description)) {
    score += 5;
  }

  // ---- Acceptance language (max 10 points) ---------------------------------
  if (ACCEPTANCE_RE.test(description)) {
    score += 10;
  } else if (description.length > 0) {
    reasons.push(
      'No acceptance language ("should", "expected", "done when") — make success criteria explicit.',
    );
  }

  if (score > 100) score = 100;
  if (score < 0) score = 0;

  return { score, reasons };
}
