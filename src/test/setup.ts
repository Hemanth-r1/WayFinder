import '@testing-library/jest-dom';

// Simple setup for utility testing
if (typeof window !== 'undefined') {
  // Mock requestAnimationFrame for browser environment
  window.requestAnimationFrame = (callback) => {
    setTimeout(() => callback(performance.now()), 0);
    return 0;
  };
  window.cancelAnimationFrame = () => {};
}