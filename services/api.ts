import { ComfyWorkflow, HistoryResponse } from '../types';

export const ensureHttps = (url: string) => {
  if (!url) return url;
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
};

export const generateClientId = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const uploadImage = async (serverUrl: string, file: File): Promise<string> => {
  const formData = new FormData();
  formData.append('image', file);

  const response = await fetch(`${serverUrl}/upload/image`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.name; // ComfyUI usually returns { name: "filename.png", ... }
};

export const queuePrompt = async (serverUrl: string, prompt: ComfyWorkflow, clientId: string): Promise<string> => {
  const response = await fetch(`${serverUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
  });

  if (!response.ok) {
    throw new Error(`Queue prompt failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.prompt_id;
};

export const getHistory = async (serverUrl: string, promptId: string): Promise<HistoryResponse> => {
  const response = await fetch(`${serverUrl}/history/${promptId}`);
  if (!response.ok) {
    throw new Error(`Get history failed: ${response.statusText}`);
  }
  return response.json();
};

export const getLogs = async (serverUrl: string): Promise<string> => {
  // Normally fetches logs to parse progress for nodes that don't report it well via WebSocket
  // For simplicity, we might fetch a small window or filter if possible, but standard is just /logs?
  // ComfyUI doesn't always expose a clean /logs endpoint per ID, usually it's global or streamed via WS.
  // The original code tried /logs?prompt_id=...
  try {
      // Note: standard ComfyUI doesn't support ?prompt_id on /logs in all versions, but we support the logic provided.
      const response = await fetch(`${serverUrl}/logs`); 
      if (!response.ok) return '';
      return await response.text();
  } catch (e) {
      return '';
  }
};

export const getImageUrl = (serverUrl: string, filename: string, subfolder: string, type: string) => {
  const params = new URLSearchParams({ filename, subfolder, type });
  return `${serverUrl}/view?${params.toString()}`;
};

export const parseConsoleProgress = (consoleText: string): number => {
    // Regex from original code
    const percentRegex = /(\d+)%\|[█ ]+\| \d+\/\d+/;
    const stepRegex = /(\d+)\/(\d+)\s+\[.+\]/;
    
    const percentMatch = consoleText.match(percentRegex);
    if (percentMatch && percentMatch[1]) {
        return parseInt(percentMatch[1]);
    }
    
    const stepMatch = consoleText.match(stepRegex);
    if (stepMatch && stepMatch[1] && stepMatch[2]) {
        const currentStep = parseInt(stepMatch[1]);
        const totalStep = parseInt(stepMatch[2]);
        return Math.floor((currentStep / totalStep) * 100);
    }
    
    if (consoleText.includes('MB usable') && consoleText.includes('MB loaded')) {
        return 5; 
    }
    
    return -1;
};