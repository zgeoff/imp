import { Collection } from '@msw/data';
import * as db from './index';

// Empties every collection; the preload runs it after each test. No
// collection holds a relation, so the order does not matter.
export function resetMockDb(): void {
  for (const value of Object.values(db)) {
    if (value instanceof Collection) {
      value.clear();
    }
  }
}
