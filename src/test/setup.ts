import '@testing-library/jest-dom/vitest';

// Deterministic Web Locks stand-in. Browser E2E exercises the real cross-tab lock.
const locksQueues = new Map<string, Promise<unknown>>();
Object.defineProperty(navigator, 'locks', { configurable: true, value: {
  request: (name: string, options: LockOptions, callback: (lock: object | null) => unknown) => {
    if (options.ifAvailable && locksQueues.has(name)) return Promise.resolve(callback(null));
    const operation = (locksQueues.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
    const settled = operation.catch(() => undefined).finally(() => { if (locksQueues.get(name) === settled) locksQueues.delete(name); });
    locksQueues.set(name, settled);
    return operation;
  },
} });
