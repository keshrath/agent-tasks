// =============================================================================
// Test helpers — creates isolated AppContext with in-memory database
// =============================================================================

import { createContext, type AppContext } from '../src/context.js';

export function createTestContext(): AppContext {
  return createContext({ path: ':memory:' });
}
