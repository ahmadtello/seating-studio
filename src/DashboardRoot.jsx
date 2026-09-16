import React from 'react';
import { FluentProvider, createLightTheme } from '@fluentui/react-components';
import App from './App.jsx';

const seatingTheme = createLightTheme({
  10: '#071a13', 20: '#0d2b20', 30: '#113d2c', 40: '#145039',
  50: '#176448', 60: '#197a56', 70: '#1f9066', 80: '#30a979',
  90: '#4bc18f', 100: '#6dd6a6', 110: '#8ce5ba', 120: '#a9efcd',
  130: '#c5f6dd', 140: '#dcfaea', 150: '#ecfdf4', 160: '#f5fff9'
});

export default function DashboardRoot() {
  return <FluentProvider theme={seatingTheme}><App /></FluentProvider>;
}
