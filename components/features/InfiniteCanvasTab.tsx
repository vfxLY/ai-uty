import React, { useState, useRef, useEffect, MouseEvent, WheelEvent } from 'react';
import Button from '../ui/Button';
import { 
  ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId, uploadImage, getLogs, parseConsoleProgress 
} from '../../services/api';
import { generateFluxWorkflow, generateEditWorkflow, generateSdxlWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

// --- Types ---

type ItemType = 'image' | 'generator' | 'editor';
type ModelType = 'flux' | 'sdxl';

interface BaseItem {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

interface ImageItem extends BaseItem {
  type: 'image';
  src: string;
}

interface GeneratorItem extends BaseItem {
  type: 'generator';
  data: {
    model: ModelType;
    prompt: string;
    negPrompt: string; // for SDXL
    width: number;
    height: number;
    steps: number;
    cfg: number;
    isGenerating: boolean;
    progress: number;
  };
}

interface EditorItem extends BaseItem {
  type: 'editor';
  data: {
    targetId: string | null; // ID of the image being edited
    prompt: string;
    steps: number;
    cfg: number;
    isGenerating: boolean;
    progress: number;
  };
}

type CanvasItem = ImageItem | GeneratorItem | EditorItem;

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

interface InfiniteCanvasTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

const InfiniteCanvasTab: React.FC<InfiniteCanvasTabProps> = ({ serverUrl, setServerUrl }) => {
  // --- State ---
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  
  // Dragging State
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<'canvas' | 'item'>('canvas');

  // Z-Index Management
  const [topZ, setTopZ] = useState(10);

  const containerRef = useRef<HTMLDivElement>(null);
  const pollInterval = useRef<number | null>(null);

  // Cleanup
  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  // --- Canvas Interaction Logic ---

  const handleWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest('textarea')) return; // Allow scrolling in textareas
    
    e.preventDefault();
    const scaleAmount = -e.deltaY * 0.001;
    const newScale = Math.min(Math.max(0.1, view.scale * (1 + scaleAmount)), 5);
    
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const mouseWorldBeforeX = (mouseX - view.x) / view.scale;
      const mouseWorldBeforeY = (mouseY - view.y) / view.scale;
      
      const newX = mouseX - mouseWorldBeforeX * newScale;
      const newY = mouseY - mouseWorldBeforeY * newScale;
      
      setView({ x: newX, y: newY, scale: newScale });
    }
  };

  const handleMouseDown = (e: MouseEvent) => {
    // If clicking on an input/button inside an item, don't drag
    if ((e.target as HTMLElement).closest('input, textarea, button, label')) {
        return;
    }

    // Check if clicking background
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('canvas-bg')) {
        setActiveItemId(null);
        setDragMode('canvas');
    } else {
        setDragMode('item');
    }
    
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      
      if (dragMode === 'item' && activeItemId) {
          setItems(prev => prev.map(item => {
              if (item.id === activeItemId) {
                  return { ...item, x: item.x + dx / view.scale, y: item.y + dy / view.scale };
              }
              return item;
          }));
          setDragStart({ x: e.clientX, y: e.clientY });
      } else {
          setView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
          setDragStart({ x: e.clientX, y: e.clientY });
      }
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleItemMouseDown = (e: MouseEvent, id: string) => {
      // Bring to front
      const newZ = topZ + 1;
      setTopZ(newZ);
      setItems(prev => prev.map(i => i.id === id ? { ...i, zIndex: newZ } : i));
      setActiveItemId(id);
      
      if (!(e.target as HTMLElement).closest('input, textarea, button')) {
        setDragMode('item');
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
      }
  };

  // --- Item Management ---

  const addGeneratorNode = () => {
      const id = Math.random().toString(36).substr(2, 9);
      const centerX = ((-view.x) + (window.innerWidth / 2) - 160) / view.scale;
      const centerY = ((-view.y) + (window.innerHeight / 2) - 200) / view.scale;

      const newItem: GeneratorItem = {
          id,
          type: 'generator',
          x: centerX,
          y: centerY,
          width: 320,
          height: 450, // Auto-height mostly
          zIndex: topZ + 1,
          data: {
              model: 'flux',
              prompt: 'A futuristic city with flying cars, neon lights, 8k resolution...',
              negPrompt: 'low quality, blurry',
              width: 1024,
              height: 1024,
              steps: 20,
              cfg: 3.5,
              isGenerating: false,
              progress: 0
          }
      };
      setTopZ(prev => prev + 1);
      setItems(prev => [...prev, newItem]);
      setActiveItemId(id);
  };

  const addEditNode = () => {
      // Find currently selected image if any
      const selectedImage = items.find(i => i.id === activeItemId && i.type === 'image');
      
      const id = Math.random().toString(36).substr(2, 9);
      // Place near selected image or center
      const centerX = selectedImage ? selectedImage.x + selectedImage.width + 20 : ((-view.x) + (window.innerWidth / 2) - 160) / view.scale;
      const centerY = selectedImage ? selectedImage.y : ((-view.y) + (window.innerHeight / 2) - 150) / view.scale;

      const newItem: EditorItem = {
          id,
          type: 'editor',
          x: centerX,
          y: centerY,
          width: 300,
          height: 350,
          zIndex: topZ + 1,
          data: {
              targetId: selectedImage ? selectedImage.id : null,
              prompt: 'Make it sunset, add rain...',
              steps: 20,
              cfg: 2.5,
              isGenerating: false,
              progress: 0
          }
      };
      setTopZ(prev => prev + 1);
      setItems(prev => [...prev, newItem]);
      setActiveItemId(id);
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (ev) => {
        const src = ev.target?.result as string;
        const img = new Image();
        img.src = src;
        img.onload = () => {
            const newItem: ImageItem = {
                id: Math.random().toString(36).substr(2, 9),
                type: 'image',
                x: ((-view.x) + (window.innerWidth / 2) - (img.width/4)) / view.scale,
                y: ((-view.y) + (window.innerHeight / 2) - (img.height/4)) / view.scale,
                width: img.width / 2,
                height: img.height / 2,
                zIndex: topZ + 1,
                src
            };
            setTopZ(prev => prev + 1);
            setItems(prev => [...prev, newItem]);
            setActiveItemId(newItem.id);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const removeItem = (id: string, e: MouseEvent) => {
      e.stopPropagation();
      setItems(prev => prev.filter(i => i.id !== id));
      if (activeItemId === id) setActiveItemId(null);
  };

  const updateItemData = (id: string, partialData: any) => {
      setItems(prev => prev.map(item => {
          if (item.id === id) {
              // @ts-ignore
              return { ...item, data: { ...item.data, ...partialData } };
          }
          return item;
      }));
  };

  // --- Generation Logic ---

  const convertSrcToFile = async (src: string): Promise<File> => {
    const res = await fetch(src);
    const blob = await res.blob();
    return new File([blob], "source.png", { type: "image/png" });
  };

  const executeGeneration = async (itemId: string) => {
      const item = items.find(i => i.id === itemId);
      if (!item) return;

      const url = ensureHttps(serverUrl);
      if (!url) {
          alert("Please check Server URL");
          return;
      }

      updateItemData(itemId, { isGenerating: true, progress: 0 });

      try {
          let workflow;
          let promptId;
          const clientId = generateClientId();

          if (item.type === 'generator') {
              const data = item.data;
              if (data.model === 'flux') {
                  workflow = generateFluxWorkflow(data.prompt, data.width, data.height, data.steps, true);
              } else {
                  workflow = generateSdxlWorkflow(data.prompt, data.negPrompt, data.width, data.height, data.steps, data.cfg);
              }
              promptId = await queuePrompt(url, workflow, clientId);
          } 
          else if (item.type === 'editor') {
              const data = item.data;
              if (!data.targetId) throw new Error("No target image selected");
              
              const targetImage = items.find(i => i.id === data.targetId) as ImageItem;
              if (!targetImage) throw new Error("Target image not found");

              updateItemData(itemId, { progress: 10 });
              const file = await convertSrcToFile(targetImage.src);
              const serverFileName = await uploadImage(url, file);
              
              workflow = generateEditWorkflow(data.prompt, serverFileName, data.steps, data.cfg);
              promptId = await queuePrompt(url, workflow, clientId);
          } else {
              return;
          }

          // Polling
          const checkStatus = async () => {
              try {
                  const history = await getHistory(url, promptId);
                  if (history[promptId]) {
                      const result = history[promptId];
                      if (result.status.status_str === 'success') {
                          // Success
                          const outputs = result.outputs;
                          for (const key in outputs) {
                              if (outputs[key].images?.length > 0) {
                                  const img = outputs[key].images[0];
                                  const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type);
                                  
                                  // Spawn Result Image
                                  const imgObj = new Image();
                                  imgObj.src = imgUrl;
                                  imgObj.onload = () => {
                                      const newItem: ImageItem = {
                                          id: Math.random().toString(36).substr(2, 9),
                                          type: 'image',
                                          // Place to the right of the generator
                                          x: item.x + item.width + 50,
                                          y: item.y,
                                          width: imgObj.width / 2, // Default scale down
                                          height: imgObj.height / 2,
                                          zIndex: topZ + 2,
                                          src: imgUrl
                                      };
                                      setTopZ(prev => prev + 2);
                                      setItems(prev => [...prev, newItem]);
                                      updateItemData(itemId, { isGenerating: false, progress: 100 });
                                  };
                                  return;
                              }
                          }
                      } else if (result.status.status_str === 'error') {
                          throw new Error('Generation Failed');
                      }
                  }

                  // Update progress (fake or log based)
                  const logs = await getLogs(url);
                  const parsed = parseConsoleProgress(logs, 20);
                  const currentProg = item.type === 'generator' ? item.data.progress : item.data.progress;
                  const newProg = parsed > 0 ? parsed : Math.min(currentProg + 2, 95);
                  
                  updateItemData(itemId, { progress: newProg });
                  setTimeout(checkStatus, 1000);
              } catch (e) {
                  console.error(e);
                  updateItemData(itemId, { isGenerating: false, progress: 0 }); // Reset on error
              }
          };

          checkStatus();

      } catch (e: any) {
          alert(e.message);
          updateItemData(itemId, { isGenerating: false, progress: 0 });
      }
  };


  // --- Renderers ---

  const renderGeneratorNode = (item: GeneratorItem) => (
      <div 
        className="w-full h-full flex flex-col p-5 bg-white/80 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/60 animate-fade-in"
        onMouseDown={e => e.stopPropagation()} // Stop canvas drag when interacting with node internals
      >
          <div className="flex justify-between items-center mb-4">
              <div className="flex gap-2 p-1 bg-slate-100 rounded-lg">
                  <button 
                    className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${item.data.model === 'flux' ? 'bg-white shadow-sm text-primary' : 'text-slate-500'}`}
                    onClick={() => updateItemData(item.id, { model: 'flux' })}
                  >
                      FLUX
                  </button>
                  <button 
                    className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${item.data.model === 'sdxl' ? 'bg-white shadow-sm text-purple-600' : 'text-slate-500'}`}
                    onClick={() => updateItemData(item.id, { model: 'sdxl' })}
                  >
                      SDXL
                  </button>
              </div>
              <div className="text-xs font-mono text-slate-400">GEN-{item.id.substr(0,4)}</div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto custom-scrollbar pr-1">
              <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">PROMPT</label>
                  <textarea 
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary/20 outline-none resize-none"
                    rows={4}
                    value={item.data.prompt}
                    onChange={(e) => updateItemData(item.id, { prompt: e.target.value })}
                    placeholder="Describe your image..."
                  />
              </div>
              
              {item.data.model === 'sdxl' && (
                  <div>
                      <label className="block text-xs font-bold text-slate-500 mb-1">NEGATIVE</label>
                      <textarea 
                        className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary/20 outline-none resize-none"
                        rows={2}
                        value={item.data.negPrompt}
                        onChange={(e) => updateItemData(item.id, { negPrompt: e.target.value })}
                      />
                  </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1">WIDTH</label>
                    <input type="number" className="w-full p-2 bg-slate-50 rounded-lg text-xs border border-slate-200" value={item.data.width} onChange={e => updateItemData(item.id, { width: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 mb-1">HEIGHT</label>
                    <input type="number" className="w-full p-2 bg-slate-50 rounded-lg text-xs border border-slate-200" value={item.data.height} onChange={e => updateItemData(item.id, { height: Number(e.target.value) })} />
                  </div>
              </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100">
             {item.data.isGenerating ? (
                 <div className="h-10 w-full bg-slate-100 rounded-xl overflow-hidden relative">
                     <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-slate-500 z-10">
                         {item.data.progress}%
                     </div>
                     <div className="h-full bg-primary/20 transition-all duration-300" style={{ width: `${item.data.progress}%` }}></div>
                 </div>
             ) : (
                 <Button onClick={() => executeGeneration(item.id)} className="py-2.5 text-sm">
                    Generate
                 </Button>
             )}
          </div>
      </div>
  );

  const renderEditNode = (item: EditorItem) => {
      const targetImage = items.find(i => i.id === item.data.targetId && i.type === 'image') as ImageItem | undefined;

      return (
        <div 
            className="w-full h-full flex flex-col p-5 bg-white/80 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/60 animate-fade-in"
            onMouseDown={e => e.stopPropagation()}
        >
            <div className="flex justify-between items-center mb-4">
                <span className="text-xs font-bold px-2 py-1 bg-blue-100 text-blue-600 rounded-md">IMAGE EDIT</span>
                <div className="text-xs font-mono text-slate-400">EDIT-{item.id.substr(0,4)}</div>
            </div>

            <div className="mb-4">
                <label className="block text-xs font-bold text-slate-500 mb-2">TARGET</label>
                {targetImage ? (
                    <div className="flex items-center gap-3 p-2 bg-blue-50 border border-blue-100 rounded-xl">
                        <img src={targetImage.src} className="w-10 h-10 rounded-lg object-cover bg-white" alt="target" />
                        <span className="text-xs text-blue-800 font-medium truncate flex-1">Selected Image</span>
                        <button onClick={() => updateItemData(item.id, { targetId: null })} className="text-blue-400 hover:text-blue-600">×</button>
                    </div>
                ) : (
                    <div className="p-4 border-2 border-dashed border-slate-200 rounded-xl text-center">
                        <p className="text-xs text-slate-400 mb-2">Drag to connect or select an image</p>
                        <div className="flex flex-wrap gap-2 justify-center max-h-24 overflow-y-auto">
                            {items.filter(i => i.type === 'image').map(img => (
                                <img 
                                    key={img.id} 
                                    src={(img as ImageItem).src} 
                                    className="w-8 h-8 rounded-md object-cover cursor-pointer hover:ring-2 ring-primary"
                                    onClick={() => updateItemData(item.id, { targetId: img.id })}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <div className="flex-1">
                <label className="block text-xs font-bold text-slate-500 mb-1">INSTRUCTION</label>
                <textarea 
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary/20 outline-none resize-none h-24"
                    value={item.data.prompt}
                    onChange={(e) => updateItemData(item.id, { prompt: e.target.value })}
                />
            </div>

            <div className="mt-4 pt-4 border-t border-slate-100">
                {item.data.isGenerating ? (
                     <div className="h-10 w-full bg-slate-100 rounded-xl overflow-hidden relative">
                         <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-slate-500 z-10">
                             {item.data.progress}%
                         </div>
                         <div className="h-full bg-blue-500/20 transition-all duration-300" style={{ width: `${item.data.progress}%` }}></div>
                     </div>
                 ) : (
                     <Button 
                        onClick={() => executeGeneration(item.id)} 
                        className="py-2.5 text-sm" 
                        disabled={!item.data.targetId}
                        variant="secondary"
                    >
                        Apply Edit
                     </Button>
                 )}
            </div>
        </div>
      );
  };

  return (
    <div className="h-full w-full relative overflow-hidden bg-slate-100 flex font-sans selection:bg-blue-100">
      {/* Canvas Area */}
      <div className="flex-1 relative h-full">
          {/* Background Grid */}
          <div 
            className="absolute inset-0 pointer-events-none opacity-20 canvas-bg"
            style={{
                backgroundImage: 'radial-gradient(#94a3b8 1px, transparent 1px)',
                backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`,
                backgroundPosition: `${view.x}px ${view.y}px`
            }}
          />
          
          <div 
            ref={containerRef}
            className="absolute inset-0 cursor-grab active:cursor-grabbing canvas-bg"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
              <div 
                className="absolute origin-top-left will-change-transform"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              >
                  {items.map(item => (
                      <div
                        key={item.id}
                        className={`absolute group transition-shadow duration-200 rounded-2xl ${activeItemId === item.id ? 'ring-4 ring-blue-400/30 shadow-2xl' : 'hover:ring-2 hover:ring-blue-400/10'}`}
                        style={{
                            left: item.x,
                            top: item.y,
                            width: item.width,
                            height: item.height,
                            zIndex: item.zIndex,
                        }}
                        onMouseDown={(e) => handleItemMouseDown(e, item.id)}
                      >
                          {/* Close Button */}
                          <button 
                             className={`absolute -top-3 -right-3 z-50 bg-white text-red-500 p-1.5 rounded-full shadow-lg opacity-0 transition-opacity hover:bg-red-50 hover:scale-110 ${activeItemId === item.id ? 'opacity-100' : 'group-hover:opacity-100'}`}
                             onClick={(e) => removeItem(item.id, e)}
                             onMouseDown={e => e.stopPropagation()}
                          >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                          </button>

                          {/* Content */}
                          {item.type === 'image' && (
                              <img 
                                src={(item as ImageItem).src} 
                                alt="item" 
                                className="w-full h-full object-cover rounded-2xl shadow-sm pointer-events-none select-none bg-white"
                              />
                          )}
                          {item.type === 'generator' && renderGeneratorNode(item as GeneratorItem)}
                          {item.type === 'editor' && renderEditNode(item as EditorItem)}
                      </div>
                  ))}
                  
                  {items.length === 0 && (
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300 font-light text-2xl select-none pointer-events-none text-center animate-pulse">
                          Click + to start creating
                      </div>
                  )}
              </div>
          </div>

          {/* Config Server Button (Subtle, Top Left) */}
          <div className="absolute top-6 left-6 group">
               <button className="p-2 bg-white/50 hover:bg-white backdrop-blur-md rounded-full text-slate-400 hover:text-primary transition-all shadow-sm">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
               </button>
               <div className="absolute top-0 left-12 bg-white rounded-xl shadow-xl p-2 w-64 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto transform -translate-x-2 group-hover:translate-x-0">
                  <label className="text-[10px] font-bold text-slate-400 px-2">SERVER URL</label>
                  <input 
                    value={serverUrl} 
                    onChange={e => setServerUrl(e.target.value)}
                    className="w-full px-2 py-1 bg-slate-50 rounded border border-slate-200 text-xs"
                  />
               </div>
          </div>

          {/* Bottom Zoom Controls */}
          <div className="absolute bottom-8 left-8 flex gap-2">
               <div className="glass-panel p-1.5 rounded-full flex gap-1 shadow-lg">
                  <button className="p-2 hover:bg-white/50 rounded-full text-slate-600 transition-colors" onClick={() => setView(prev => ({ ...prev, scale: Math.max(prev.scale / 1.2, 0.1) }))}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                  <span className="flex items-center justify-center w-10 text-xs font-mono text-slate-500">{Math.round(view.scale * 100)}%</span>
                  <button className="p-2 hover:bg-white/50 rounded-full text-slate-600 transition-colors" onClick={() => setView(prev => ({ ...prev, scale: Math.min(prev.scale * 1.2, 5) }))}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
               </div>
               <button 
                className="glass-panel p-2.5 rounded-full text-slate-600 hover:bg-white hover:text-primary transition-colors shadow-lg"
                onClick={() => setView({ x: 0, y: 0, scale: 1 })}
               >
                 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
               </button>
          </div>

          {/* Floating Action Button (FAB) & Menu */}
          <div className="absolute left-6 top-1/2 -translate-y-1/2 z-50 flex flex-row items-center gap-6 group">
               {/* Main Plus Button */}
               <button className="w-16 h-16 bg-gradient-to-br from-primary to-blue-600 rounded-full shadow-2xl shadow-blue-500/40 flex items-center justify-center text-white transition-transform duration-300 group-hover:rotate-45 hover:scale-105 active:scale-95 shrink-0">
                   <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
               </button>

               {/* Menu Items */}
               <div className="flex flex-col gap-3 items-start opacity-0 group-hover:opacity-100 transition-all duration-300 transform -translate-x-8 group-hover:translate-x-0 pointer-events-none group-hover:pointer-events-auto">
                   
                   <button onClick={addGeneratorNode} className="flex items-center gap-3 group/item">
                       <div className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center text-slate-600 group-hover/item:text-purple-500 group-hover/item:scale-110 transition-all">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.34"></path><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"></polygon></svg>
                       </div>
                       <span className="text-sm font-bold text-slate-600 bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg shadow-sm whitespace-nowrap">Text to Image</span>
                   </button>

                   <button onClick={addEditNode} className="flex items-center gap-3 group/item">
                       <div className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center text-slate-600 group-hover/item:text-blue-500 group-hover/item:scale-110 transition-all">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                       </div>
                       <span className="text-sm font-bold text-slate-600 bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg shadow-sm whitespace-nowrap">Image Edit</span>
                   </button>
                   
                   {/* Add Image Upload Hidden Input */}
                   <input type="file" id="fab-upload" className="hidden" accept="image/*" onChange={handleUpload} />
                   
                   <label htmlFor="fab-upload" className="flex items-center gap-3 cursor-pointer group/item">
                       <div className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center text-slate-600 group-hover/item:text-primary group-hover/item:scale-110 transition-all">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                       </div>
                       <span className="text-sm font-bold text-slate-600 bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg shadow-sm whitespace-nowrap">Upload Image</span>
                   </label>
               </div>
          </div>
      </div>
    </div>
  );
};

export default InfiniteCanvasTab;