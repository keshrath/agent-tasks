// =============================================================================
// Scenario registry — add new scenarios here
// =============================================================================

import { csvExportScenario } from './csv-export.js';
import { auditRecallScenario } from './audit-recall.js';
import type { Scenario } from './types.js';

export type { Scenario, SeedTask, SeedFile, Question } from './types.js';

export const SCENARIOS: Record<string, Scenario> = {
  'csv-export': csvExportScenario,
  'audit-recall': auditRecallScenario,
};

export function getScenario(name: string): Scenario {
  const s = SCENARIOS[name];
  if (!s) {
    throw new Error(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return s;
}
