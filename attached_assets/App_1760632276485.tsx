// src/App.tsx
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import TestHarness from './TestHarness';

export default function App() {
  return (
    <Routes>
      {/* your app’s other routes go above/below as you add them */}
      <Route path='/harness' element={<TestHarness />} />
      {/* Optional: root route shows a link to the harness */}
      <Route
        path='/'
        element={
          <div style={{ padding: 24 }}>
            <h1>DreamStream</h1>
            <p>
              <a href='/harness'>Open WebRTC Test Harness</a>
            </p>
          </div>
        }
      />
    </Routes>
  );
}
