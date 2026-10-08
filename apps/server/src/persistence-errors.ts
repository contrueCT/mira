import { DurableOperationError } from '@mira/life';

const persistenceNotice = 'Persistence write failed and the runtime stopped. This is a temporary server notice; no durable tool diagnostic is confirmed. Check PostgreSQL and recover saved state before retrying. External tool effects may already have happened.';
/** Volatile safe status only, never another history record or tool result. */
export class PersistenceFailureNotice {
  readonly #trusted = true;
  private constructor() { Object.freeze(this); }
  static from(error: unknown): PersistenceFailureNotice | null {
    return DurableOperationError.categoryOf(error) === 'persistence-write-failure' ? new PersistenceFailureNotice() : null;
  }
  static text(value: unknown): string | undefined {
    return typeof value === 'object' && value !== null && #trusted in value ? persistenceNotice : undefined;
  }
}
