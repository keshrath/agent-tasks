// =============================================================================
// Scenario A: csv-export — mid-build state (the original v1 scenario)
// =============================================================================

import {
  SEED_TASKS as ORIG_TASKS,
  SEED_FILES as ORIG_FILES,
  QUESTIONS as ORIG_QUESTIONS,
} from '../scenario.js';
import type { Scenario } from './types.js';

export const csvExportScenario: Scenario = {
  name: 'csv-export',
  description:
    '6 tasks, mid-build snapshot. 3 worker agents adding CSV export to a TODO app at minute 8 of an estimated 15-minute build. Tests LIVE STATE visibility.',
  project: 'csv-export',
  contextHint:
    'You are a MANAGER observing an in-flight feature build by 3 worker agents. ' +
    'The feature is "Add CSV export to a TODO app". This is a snapshot at minute 8 ' +
    'of an estimated 15-minute build.',
  tasks: ORIG_TASKS,
  files: ORIG_FILES,
  questions: ORIG_QUESTIONS,
};
