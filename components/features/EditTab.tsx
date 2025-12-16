import React, { useState, useRef, useEffect } from 'react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { Input, TextArea } from '../ui/Input';
import Slider from '../ui/Slider';
import { ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId, uploadImage } from '../../services/api';
import { generateEditWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

interface EditTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

const EditTab: React.FC<EditTabProps> = ({ serverUrl, setServerUrl }) => {
  const [prompt, setPrompt] = useState('修改姿势敞开衣服露出诱人的胸部 穿着黑丝内衣');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(2.5);
  
  const [status, setStatus] = useState<GenerationStatus>({
    isGenerating: false,
    progress: 0,
    statusText: '',
  });

  const pollInterval = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      setFile(f);
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target?.result as string);
      reader.readAsDataURL(f);
    }
  };

  const handleGenerate = async () => {
    const url = ensureHttps(serverUrl);
    if (!url || !file) {
      setStatus(prev => ({ ...prev, error: 'Please enter server URL and upload an image' }));
      return;
    }
    
    setStatus({ isGenerating: true, progress: 5, statusText: 'Uploading image...', imageUrl: undefined, error: undefined });
    
    try {
      const imageName = await uploadImage(url, file);
      
      setStatus({ isGenerating: true, progress: 15, statusText: 'Queuing task...', imageUrl: undefined });
      
      const clientId = generateClientId();
      const workflow = generateEditWorkflow(prompt, imageName, steps, cfg);
      const promptId = await queuePrompt(url, workflow, clientId);
      
      let fakeProgress = 15;
      
      pollInterval.current = window.setInterval(async () => {
        try {
          const history = await getHistory(url, promptId);
          if (history[promptId]) {
            const result = history[promptId];
            if (result.status.status_str === 'success') {
               const outputs = result.outputs;
               for (const key in outputs) {
                 if (outputs[key].images && outputs[key].images.length > 0) {
                   const img = outputs[key].images[0];
                   const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type);
                   setStatus({ isGenerating: false, progress: 100, statusText: 'Completed', imageUrl: imgUrl });
                   if (pollInterval.current) clearInterval(pollInterval.current);
                   return;
                 }
               }
            } else if (result.status.status_str === 'error') {
               throw new Error(result.status.error || 'Unknown error');
            }
          }
          
          fakeProgress = Math.min(fakeProgress + 2, 90);
          setStatus(prev => ({ ...prev, progress: fakeProgress, statusText: 'Processing...' }));

        } catch (e: any) {
           console.error(e);
        }
      }, 1000);

    } catch (e: any) {
      setStatus({ isGenerating: false, progress: 0, statusText: '', error: e.message });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-4 space-y-6">
        <Card title="Edit Settings" icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>}>
          <div className="mb-6">
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 ml-1">Source Image</label>
            <div className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${preview ? 'border-primary/50 bg-primary/5' : 'border-gray-300 hover:bg-gray-50'}`}>
              <input type="file" id="img-upload" className="hidden" accept="image/*" onChange={handleFileChange} />
              <label htmlFor="img-upload" className="cursor-pointer w-full h-full block">
                {preview ? (
                  <img src={preview} alt="Preview" className="max-h-48 mx-auto rounded-lg shadow-sm" />
                ) : (
                  <div className="py-8 text-gray-400">
                    <svg className="w-12 h-12 mx-auto mb-2 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                    <span className="text-sm">Click to upload image</span>
                  </div>
                )}
              </label>
            </div>
          </div>
          
          <TextArea label="Modification Prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
          <Slider label="Steps" min={10} max={100} step={5} value={steps} onChange={e => setSteps(Number(e.target.value))} />
          <Slider label="CFG Scale" min={0.5} max={10} step={0.5} value={cfg} onChange={e => setCfg(Number(e.target.value))} />

          <Button onClick={handleGenerate} loading={status.isGenerating}>
            Edit Image
          </Button>
          
          {status.error && (
            <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100">
               {status.error}
            </div>
          )}
        </Card>
      </div>

      <div className="lg:col-span-8">
        <Card className="h-full min-h-[600px] flex flex-col" title="Result">
          {status.isGenerating && (
             <div className="mb-6 space-y-2">
               <div className="flex justify-between text-xs font-semibold text-gray-500 uppercase">
                 <span>{status.statusText}</span>
                 <span>{Math.round(status.progress)}%</span>
               </div>
               <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                 <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${status.progress}%` }}></div>
               </div>
             </div>
          )}

          <div className="flex-1 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 flex items-center justify-center relative overflow-hidden">
             {status.imageUrl ? (
               <img src={status.imageUrl} alt="Result" className="max-w-full max-h-[700px] object-contain shadow-2xl rounded-lg" />
             ) : (
               <div className="text-center text-gray-400">
                  <p className="font-medium">Edited image will appear here</p>
               </div>
             )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default EditTab;