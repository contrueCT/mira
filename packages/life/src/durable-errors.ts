/** Core-owned tags let adapters recognize persistence failures without parsing
 * external messages, driver codes, causes or headers. These are failure facts,
 * never proof of a tool's external outcome. */
export type DurableFailureCategory = 'event-content-conflict' | 'persistence-write-failure';
export class DurableOperationError extends Error {
  readonly #category: DurableFailureCategory | undefined;
  constructor(category: DurableFailureCategory | undefined, message: string, options?: ErrorOptions) {
    super(message, options);
    if (category !== undefined && category !== 'event-content-conflict' && category !== 'persistence-write-failure') throw new Error('Invalid durable failure category');
    this.name = 'DurableOperationError';
    this.#category = category;
  }
  static categoryOf(error: unknown): DurableFailureCategory | undefined {
    // A lookalike object or a forged prototype has no private instance brand.
    return typeof error === 'object' && error !== null && #category in error ? error.#category : undefined;
  }
  static is(error: unknown): error is DurableOperationError {
    return typeof error === 'object' && error !== null && #category in error;
  }
}
