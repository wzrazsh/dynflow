import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

describe('App', () => {
  it('renders DynFlow heading', () => {
    render(<App />);
    expect(screen.getByText('DynFlow')).toBeDefined();
  });
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Child content')).toBeDefined();
  });

  it('renders fallback on error', () => {
    const ThrowingComponent = () => {
      throw new Error('Test crash');
    };

    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(screen.getByText('Test crash')).toBeDefined();
  });

  it('uses custom fallback when provided', () => {
    const ThrowingComponent = () => {
      throw new Error('Test crash');
    };

    render(
      <ErrorBoundary fallback={<div>Custom error UI</div>}>
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom error UI')).toBeDefined();
  });
});
