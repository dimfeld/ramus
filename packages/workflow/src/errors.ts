export class CancelledError extends Error {
  name = 'CancelledError';

  constructor() {
    super('Cancelled');
  }
}
