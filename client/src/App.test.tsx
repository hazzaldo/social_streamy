import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

describe('<App />', () => {
  it('renders the hero and CTAs', () => {
    render(<App />);

    // Title
    expect(screen.getByTestId('text-app-title')).toHaveTextContent(
      /social streamy/i
    );

    // Description (optional, but useful)
    expect(screen.getByTestId('text-app-description')).toBeInTheDocument();

    // CTAs
    expect(screen.getByTestId('button-start-host')).toBeInTheDocument();
    expect(screen.getByTestId('button-join-viewer')).toBeInTheDocument();
  });
});
