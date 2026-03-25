// =============================================================================
// agent-tasks — Input validation constants
//
// Shared limits and patterns for domain-layer validation.
// =============================================================================

export const MAX_TITLE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 50_000;
export const MAX_RESULT_LENGTH = 50_000;
export const MAX_ARTIFACT_CONTENT_LENGTH = 100_000;
export const MAX_ARTIFACT_NAME_LENGTH = 128;
export const MAX_PROJECT_NAME_LENGTH = 128;
export const MAX_TAG_LENGTH = 64;
export const MAX_TAGS_COUNT = 20;
export const MAX_STAGE_NAME_LENGTH = 64;
export const MAX_STAGES_COUNT = 20;
export const MAX_LIST_LIMIT = 500;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function rejectControlChars(value: string, field: string): void {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`"${field}" must not contain control characters.`);
  }
}

export function rejectNullBytes(value: string, field: string): void {
  if (value.includes('\0')) {
    throw new Error(`"${field}" must not contain null bytes.`);
  }
}
