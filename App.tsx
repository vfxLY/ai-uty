import React, { useState } from 'react';
import InfiniteCanvasTab from './components/features/InfiniteCanvasTab';

const App: React.FC = () => {
  const [serverUrl, setServerUrl] = useState('https://17610400098.top');

  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-100">
      <InfiniteCanvasTab serverUrl={serverUrl} setServerUrl={setServerUrl} />
      
      {/* Global Styles for Animations */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-fade-in {
          animation: fadeIn 0.4s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default App;