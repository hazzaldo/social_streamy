// vitest.setup.ts

// Extend expect() with jest-dom matchers
import '@testing-library/jest-dom/vitest';

// If your code uses fetch in the browser, bring a fetch polyfill
import 'whatwg-fetch';

// React Testing Library hint (prevents act() warnings in some cases)
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Optional: stub things jsdom doesn’t have (uncomment if you hit errors)
// globalThis.matchMedia = globalThis.matchMedia || (() => ({
//   matches: false,
//   addListener: () => {},
//   removeListener: () => {},
//   addEventListener: () => {},
//   removeEventListener: () => {},
//   dispatchEvent: () => false,
// })) as any;
