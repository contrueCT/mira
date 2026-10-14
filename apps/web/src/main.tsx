import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthGate } from './AuthGate.tsx';
import './styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing Mira root');
createRoot(root).render(<StrictMode><AuthGate><App /></AuthGate></StrictMode>);
