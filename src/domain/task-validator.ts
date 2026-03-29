// =============================================================================
// agent-tasks — Task input validation
//
// Extracted from TaskService. Pure validation functions — no DB access.
// =============================================================================

import { ValidationError } from '../types.js';
import {
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_RESULT_LENGTH,
  MAX_ARTIFACT_CONTENT_LENGTH,
  MAX_ARTIFACT_NAME_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS_COUNT,
  rejectNullBytes,
  rejectControlChars,
} from './validate.js';

export function validateTitle(title: string): void {
  rejectNullBytes(title, 'title');
  rejectControlChars(title, 'title');
  const trimmed = title.trim();
  if (!trimmed) throw new ValidationError('Title must not be empty.');
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`Title too long (max ${MAX_TITLE_LENGTH} chars).`);
  }
}

export function validateDescription(desc: string): void {
  rejectNullBytes(desc, 'description');
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Description too long (max ${MAX_DESCRIPTION_LENGTH} chars).`);
  }
}

export function validateResult(result: string): void {
  rejectNullBytes(result, 'result');
  if (result.length > MAX_RESULT_LENGTH) {
    throw new ValidationError(`Result too long (max ${MAX_RESULT_LENGTH} chars).`);
  }
}

export function validateProjectName(project: string): void {
  rejectNullBytes(project, 'project');
  rejectControlChars(project, 'project');
  if (project.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ValidationError(`Project name too long (max ${MAX_PROJECT_NAME_LENGTH} chars).`);
  }
}

export function validateAssignee(name: string): void {
  rejectNullBytes(name, 'assign_to');
  rejectControlChars(name, 'assign_to');
  if (!name.trim()) throw new ValidationError('Assignee name must not be empty.');
}

export function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS_COUNT) {
    throw new ValidationError(`Too many tags (max ${MAX_TAGS_COUNT}).`);
  }
  for (const tag of tags) {
    rejectNullBytes(tag, 'tag');
    rejectControlChars(tag, 'tag');
    if (tag.length > MAX_TAG_LENGTH) {
      throw new ValidationError(`Tag too long: "${tag}" (max ${MAX_TAG_LENGTH} chars).`);
    }
  }
}

export function validateArtifactName(name: string): void {
  rejectNullBytes(name, 'artifact name');
  rejectControlChars(name, 'artifact name');
  if (!name.trim()) throw new ValidationError('Artifact name must not be empty.');
  if (name.length > MAX_ARTIFACT_NAME_LENGTH) {
    throw new ValidationError(`Artifact name too long (max ${MAX_ARTIFACT_NAME_LENGTH} chars).`);
  }
}

export function validateArtifactContent(content: string): void {
  rejectNullBytes(content, 'artifact content');
  if (content.length > MAX_ARTIFACT_CONTENT_LENGTH) {
    throw new ValidationError(
      `Artifact content too long (max ${MAX_ARTIFACT_CONTENT_LENGTH} chars).`,
    );
  }
}
