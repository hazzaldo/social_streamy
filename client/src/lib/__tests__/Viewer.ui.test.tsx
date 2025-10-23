import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Viewer from '@/pages/Viewer';

// Mock wouter route params so component mounts cleanly
vi.mock('wouter', () => ({
  useRoute: () => [true, { id: 'demo' }]
}));

// Avoid real websockets/media
Object.defineProperty(global, 'WebSocket', {
  value: class {
    readyState = 0;
    close() {}
  },
  writable: true
});

Object.defineProperty(global.navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn() },
  configurable: true
});

describe('<Viewer />', () => {
  it('shows Join Stream when not joined', () => {
    render(<Viewer />);
    expect(screen.getByTestId('button-join-stream')).toBeInTheDocument();
  });
});
