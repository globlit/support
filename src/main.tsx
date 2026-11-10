import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import {SessionGate} from './SessionGate';
import {ToastProvider} from './Toasts';
import './style.css';
import './workspace.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><SessionGate><App/></SessionGate></ToastProvider></React.StrictMode>);
