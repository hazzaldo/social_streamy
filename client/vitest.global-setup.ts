// client/vitest.global-setup.ts

export default async function globalSetup(): Promise<void> {
  if (!Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')) {
    Object.defineProperty(ArrayBuffer.prototype, 'resizable', {
      configurable: true,
      enumerable: false,
      get() {
        return false;
      }
    });
  }

  if (!(globalThis as any).SharedArrayBuffer) {
    (globalThis as any).SharedArrayBuffer = ArrayBuffer;
  }

  const sabPrototype = (globalThis as any).SharedArrayBuffer.prototype;
  if (!Object.getOwnPropertyDescriptor(sabPrototype, 'growable')) {
    Object.defineProperty(sabPrototype, 'growable', {
      configurable: true,
      enumerable: false,
      get() {
        return false;
      }
    });
  }
}
