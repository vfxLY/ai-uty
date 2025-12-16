import React, { useState, useRef, useEffect, MouseEvent, WheelEvent, DragEvent, KeyboardEvent, useCallback } from 'react';
import Button from '../ui/Button';
import { 
  ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId, uploadImage, getLogs, parseConsoleProgress 
} from '../../services/api';
import { generateFluxWorkflow, generateEditWorkflow, generateSdxlWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

// --- Constants ---

const SIZE_PRESETS = [
  { label: 'Square (1:1)', w: 1024, h: 1024 },
  { label: 'Landscape (16:9)', w: 1280, h: 720 },
  { label: 'Portrait (9:16)', w: 720, h: 1280 },
  { label: 'Tall (8:16)', w: 512, h: 1024 },
  { label: 'Classic (4:3)', w: 1152, h: 864 },
];

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
  parentId?: string; // Track upstream source
}

interface ImageItem extends BaseItem {
  type: 'image';
  src: string;
  // Edit state
  editPrompt?: string;
  isEditing?: boolean;
  editProgress?: number;
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
    // Unified node fields
    resultImage?: string;
    mode: 'input' | 'result';
    // Edit state for result
    editPrompt?: string;
    isEditing?: boolean;
    editProgress?: number;
  };
}

interface EditorItem extends BaseItem {
  type: 'editor';
  data: {
    targetId: string | null;
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

interface SelectionBox {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

const InfiniteCanvasTab: React.FC<InfiniteCanvasTabProps> = ({ serverUrl, setServerUrl }) => {
  // --- State ---
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  
  // Selection State
  const [activeItemId, setActiveItemId] = useState<string | null>(null); // The one currently being edited/focused
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); // Multi-selection set
  const [activeSizeMenuId, setActiveSizeMenuId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  
  // Copy/Paste State
  const [clipboard, setClipboard] = useState<CanvasItem[]>([]);
  
  // Dragging State
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<'canvas' | 'item' | 'selection'>('canvas');
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  // Mouse Tracking for Paste
  const mousePosRef = useRef({ x: 0, y: 0 });

  // Z-Index Management
  const [topZ, setTopZ] = useState(10);

  const containerRef = useRef<HTMLDivElement>(null);
  const pollInterval = useRef<number | null>(null);

  // --- Actions ---
  
  const pasteItems = useCallback(() => {
      if (clipboard.length === 0) return;

      // 1. Calculate center of clipboard items
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      clipboard.forEach(item => {
          minX = Math.min(minX, item.x);
          minY = Math.min(minY, item.y);
          maxX = Math.max(maxX, item.x + item.width);
          maxY = Math.max(maxY, item.y + item.height);
      });
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // 2. Determine paste target position (Mouse Cursor)
      let targetX = centerX + 20; // fallback offset
      let targetY = centerY + 20;

      if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const clientX = mousePosRef.current.x;
          const clientY = mousePosRef.current.y;
          
          // Only paste at mouse if mouse is effectively within/near window (simple check)
          if (clientX > 0 && clientY > 0) {
              const localX = clientX - rect.left;
              const localY = clientY - rect.top;
              targetX = (localX - view.x) / view.scale;
              targetY = (localY - view.y) / view.scale;
          }
      }

      // 3. Calculate offset from center to target
      const dx = targetX - centerX;
      const dy = targetY - centerY;

      const newIdsMap = new Map<string, string>();
      const newItems: CanvasItem[] = [];
      let maxZ = topZ;

      // First pass: Duplicate items and generate new IDs
      clipboard.forEach(item => {
          const newId = Math.random().toString(36).substr(2, 9);
          newIdsMap.set(item.id, newId);
          maxZ++;
          
          const clonedItem = JSON.parse(JSON.stringify(item));
          clonedItem.id = newId;
          clonedItem.x = item.x + dx;
          clonedItem.y = item.y + dy;
          clonedItem.zIndex = maxZ;
          clonedItem.parentId = undefined; // Detach parent linkage for simplicity
          
          newItems.push(clonedItem);
      });

      // Second pass: Restore internal references if both target and source were pasted
      newItems.forEach(item => {
           if (item.type === 'editor') {
               const oldTargetId = (item as EditorItem).data.targetId;
               if (oldTargetId && newIdsMap.has(oldTargetId)) {
                   (item as EditorItem).data.targetId = newIdsMap.get(oldTargetId) || null;
               } else {
                   (item as EditorItem).data.targetId = null; // Clear if target wasn't copied
               }
           }
      });

      setTopZ(maxZ);
      setItems(prev => [...prev, ...newItems]);
      
      // Select the newly pasted items
      const newSelectedIds = new Set(newItems.map(i => i.id));
      setSelectedIds(newSelectedIds);
      if (newItems.length === 1) setActiveItemId(newItems[0].id);
  }, [clipboard, topZ, view]);

  // Cleanup & Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
        if (e.code === 'Space') {
           setIsSpacePressed(true);
        }
        
        // Copy: Ctrl+C
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (selectedIds.size > 0) {
                const selectedItems = items.filter(i => selectedIds.has(i.id));
                setClipboard(selectedItems);
            }
        }

        // Paste: Ctrl+V
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (clipboard.length > 0) {
                pasteItems();
            }
        }
        
        // Delete: Delete/Backspace (only if not typing)
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
            if (!(e.target as HTMLElement).matches('input, textarea')) {
                setItems(prev => prev.filter(i => !selectedIds.has(i.id)));
                setSelectedIds(new Set());
                setActiveItemId(null);
            }
        }
    };

    const handleKeyUp = (e: globalThis.KeyboardEvent) => {
        if (e.code === 'Space') {
           setIsSpacePressed(false);
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [selectedIds, items, clipboard, pasteItems]);

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
    // Close size menu if clicking outside
    if (!(e.target as HTMLElement).closest('.size-menu-container')) {
        setActiveSizeMenuId(null);
    }

    // If clicking on an input/button inside an item, don't drag or select
    if ((e.target as HTMLElement).closest('input, textarea, button, label')) {
        return;
    }

    const isCanvasBg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('canvas-bg');
    
    if (isCanvasBg) {
        // Background Click
        if (isSpacePressed || e.button === 1) { // Middle mouse or Space -> Pan
            setDragMode('canvas');
        } else {
            // Default -> Selection Box
            setDragMode('selection');
            if (!e.shiftKey) {
                setSelectedIds(new Set());
                setActiveItemId(null);
            }
            // Start selection box relative to container
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                setSelectionBox({ startX: x, startY: y, currentX: x, currentY: y });
            }
        }
    } else {
        // Item Click (Handled via bubbling or explicitly if needed, but here we assume handleItemMouseDown captured it first if it hit an item container)
        // Actually, handleItemMouseDown is on the item div, so this main handler handles background or bubbled events.
        // If it bubbled up from an item, handleItemMouseDown already ran.
    }
    
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: MouseEvent) => {
    // Track global mouse position for pasting
    mousePosRef.current = { x: e.clientX, y: e.clientY };

    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      
      if (dragMode === 'item') {
          // Move all selected items
          setItems(prev => prev.map(item => {
              if (selectedIds.has(item.id)) {
                  return { ...item, x: item.x + dx / view.scale, y: item.y + dy / view.scale };
              }
              return item;
          }));
          setDragStart({ x: e.clientX, y: e.clientY });
      } 
      else if (dragMode === 'canvas') {
          setView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
          setDragStart({ x: e.clientX, y: e.clientY });
      }
      else if (dragMode === 'selection' && selectionBox && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const currentX = e.clientX - rect.left;
          const currentY = e.clientY - rect.top;
          
          setSelectionBox(prev => prev ? ({ ...prev, currentX, currentY }) : null);

          // Calculate selection intersection
          const boxX = Math.min(selectionBox.startX, currentX);
          const boxY = Math.min(selectionBox.startY, currentY);
          const boxW = Math.abs(currentX - selectionBox.startX);
          const boxH = Math.abs(currentY - selectionBox.startY);

          // Convert screen box to world coordinates for intersection checking
          const worldX = (boxX - view.x) / view.scale;
          const worldY = (boxY - view.y) / view.scale;
          const worldW = boxW / view.scale;
          const worldH = boxH / view.scale;

          const newSelectedIds = new Set(e.shiftKey ? selectedIds : []);
          
          items.forEach(item => {
              // Simple AABB intersection
              if (
                  item.x < worldX + worldW &&
                  item.x + item.width > worldX &&
                  item.y < worldY + worldH &&
                  item.y + item.height > worldY
              ) {
                  newSelectedIds.add(item.id);
              }
          });
          setSelectedIds(newSelectedIds);
      }
    }
  };

  const handleMouseUp = () => {
      setIsDragging(false);
      setSelectionBox(null);
      // Don't clear dragMode immediately to prevent clicks after drag? No, reset it.
      setDragMode('canvas'); 
  };

  // --- Drag and Drop Logic ---

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (!file.type.startsWith('image/')) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const src = ev.target?.result as string;
        const img = new Image();
        img.src = src;
        img.onload = () => {
            const clientX = e.clientX;
            const clientY = e.clientY;
            const x = (clientX - view.x) / view.scale;
            const y = (clientY - view.y) / view.scale;

            const newItem: ImageItem = {
                id: Math.random().toString(36).substr(2, 9),
                type: 'image',
                x: x - (img.width / 4), 
                y: y - (img.height / 4),
                width: img.width / 2,
                height: img.height / 2,
                zIndex: topZ + 1,
                src
            };
            setTopZ(prev => prev + 1);
            setItems(prev => [...prev, newItem]);
            setActiveItemId(newItem.id);
            setSelectedIds(new Set([newItem.id]));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleItemMouseDown = (e: MouseEvent, id: string) => {
      e.stopPropagation(); // Prevent canvas background click
      
      // Bring to front
      const newZ = topZ + 1;
      setTopZ(newZ);
      setItems(prev => prev.map(i => i.id === id ? { ...i, zIndex: newZ } : i));
      
      // Selection Logic
      if (e.shiftKey) {
          const newSelected = new Set(selectedIds);
          if (newSelected.has(id)) {
              newSelected.delete(id);
              if (activeItemId === id) setActiveItemId(null);
          } else {
              newSelected.add(id);
              setActiveItemId(id);
          }
          setSelectedIds(newSelected);
      } else {
          // If clicking an item that is already selected, don't clear selection (allow group drag)
          if (!selectedIds.has(id)) {
              setSelectedIds(new Set([id]));
              setActiveItemId(id);
          } else {
              setActiveItemId(id); // Just update focus
          }
      }

      if (!(e.target as HTMLElement).closest('input, textarea, button')) {
        setDragMode('item');
        setIsDragging(true);
        setDragStart({ x: e.clientX, y: e.clientY });
      }
  };

  // --- Item Management ---

  const addGeneratorNode = () => {
      const id = Math.random().toString(36).substr(2, 9);
      const centerX = ((-view.x) + (window.innerWidth / 2) - 200) / view.scale;
      const centerY = ((-view.y) + (window.innerHeight / 2) - 200) / view.scale;

      const newItem: GeneratorItem = {
          id,
          type: 'generator',
          x: centerX,
          y: centerY,
          width: 400,
          height: 400,
          zIndex: topZ + 1,
          data: {
              model: 'flux',
              prompt: '',
              negPrompt: '',
              width: 1024,
              height: 1024,
              steps: 20,
              cfg: 3.5,
              isGenerating: false,
              progress: 0,
              mode: 'input'
          }
      };
      setTopZ(prev => prev + 1);
      setItems(prev => [...prev, newItem]);
      setActiveItemId(id);
      setSelectedIds(new Set([id]));
  };

  const addEditNode = () => {
      const selectedImage = items.find(i => i.id === activeItemId && i.type === 'image');
      
      const id = Math.random().toString(36).substr(2, 9);
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
          parentId: selectedImage ? selectedImage.id : undefined,
          data: {
              targetId: selectedImage ? selectedImage.id : null,
              prompt: 'Make it sunset...',
              steps: 20,
              cfg: 2.5,
              isGenerating: false,
              progress: 0
          }
      };
      setTopZ(prev => prev + 1);
      setItems(prev => [...prev, newItem]);
      setActiveItemId(id);
      setSelectedIds(new Set([id]));
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
            setSelectedIds(new Set([newItem.id]));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const removeItem = (id: string, e: MouseEvent) => {
      e.stopPropagation();
      setItems(prev => prev.filter(i => i.id !== id));
      if (activeItemId === id) setActiveItemId(null);
      setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
      });
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

  const updateImageItem = (id: string, partialData: Partial<ImageItem>) => {
      setItems(prev => prev.map(item => {
          if (item.id === id && item.type === 'image') {
              return { ...item, ...partialData };
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

  const executeEdit = async (itemId: string, prompt: string) => {
      const item = items.find(i => i.id === itemId);
      if (!item) return;

      const url = ensureHttps(serverUrl);
      if (!url) {
          alert("Please check Server URL");
          return;
      }

      // Set editing state
      if (item.type === 'image') {
          updateImageItem(itemId, { isEditing: true, editProgress: 0 });
      } else if (item.type === 'generator') {
          updateItemData(itemId, { isEditing: true, editProgress: 0 });
      }

      try {
          // 1. Get Source Image
          let src = '';
          if (item.type === 'image') {
              src = (item as ImageItem).src;
          } else if (item.type === 'generator') {
              src = (item as GeneratorItem).data.resultImage || '';
          }
          
          if (!src) throw new Error("No source image");

          // 2. Upload
          const file = await convertSrcToFile(src);
          const serverFileName = await uploadImage(url, file);

          if (item.type === 'image') updateImageItem(itemId, { editProgress: 20 });
          else updateItemData(itemId, { editProgress: 20 });

          // 3. Queue Prompt
          const clientId = generateClientId();
          // Use default steps/cfg for quick edit
          const workflow = generateEditWorkflow(prompt, serverFileName, 20, 2.5);
          const promptId = await queuePrompt(url, workflow, clientId);

          // 4. Poll
          const checkStatus = async () => {
              try {
                  const history = await getHistory(url, promptId);
                  if (history[promptId]) {
                      const result = history[promptId];
                      if (result.status.status_str === 'success') {
                           const outputs = result.outputs;
                           for (const key in outputs) {
                              if (outputs[key].images?.length > 0) {
                                  const img = outputs[key].images[0];
                                  const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type);
                                  
                                  // SUCCESS: Spawn NEW Image Item next to original
                                  const newItem: ImageItem = {
                                      id: Math.random().toString(36).substr(2, 9),
                                      type: 'image',
                                      x: item.x + item.width + 40,
                                      y: item.y,
                                      width: item.width, // Inherit size
                                      height: item.height,
                                      zIndex: topZ + 2, // Bring to front
                                      parentId: item.id, // LINK TO PARENT
                                      src: imgUrl
                                  };

                                  setTopZ(prev => prev + 2);
                                  setItems(prev => [...prev, newItem]);
                                  setSelectedIds(new Set([newItem.id])); // Select new item

                                  // Reset Source Item State
                                  if (item.type === 'image') {
                                      updateImageItem(itemId, { isEditing: false, editProgress: 100, editPrompt: '' });
                                  } else {
                                      updateItemData(itemId, { isEditing: false, editProgress: 100, editPrompt: '' });
                                  }
                                  return;
                              }
                           }
                      } else if (result.status.status_str === 'error') {
                           throw new Error("Edit failed");
                      }
                  }

                  // Progress
                  const logs = await getLogs(url);
                  const parsed = parseConsoleProgress(logs, 20);
                  const currentProg = item.type === 'image' ? ((item as ImageItem).editProgress || 20) : ((item as GeneratorItem).data.editProgress || 20);
                  const newProg = parsed > 0 ? parsed : Math.min(currentProg + 2, 95);

                  if (item.type === 'image') updateImageItem(itemId, { editProgress: newProg });
                  else updateItemData(itemId, { editProgress: newProg });

                  setTimeout(checkStatus, 1000);

              } catch (e) {
                  console.error(e);
                  // Reset on error
                  if (item.type === 'image') updateImageItem(itemId, { isEditing: false });
                  else updateItemData(itemId, { isEditing: false });
              }
          };
          checkStatus();

      } catch (e: any) {
          alert(e.message);
          if (item.type === 'image') updateImageItem(itemId, { isEditing: false });
          else updateItemData(itemId, { isEditing: false });
      }
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
                                  
                                  // Update logic based on item type
                                  if (item.type === 'generator') {
                                      // Transform the node itself
                                      updateItemData(itemId, { 
                                          isGenerating: false, 
                                          progress: 100, 
                                          resultImage: imgUrl, 
                                          mode: 'result'
                                      });
                                  } else {
                                      // Editor spawns new image
                                      const imgObj = new Image();
                                      imgObj.src = imgUrl;
                                      imgObj.onload = () => {
                                          const newItem: ImageItem = {
                                              id: Math.random().toString(36).substr(2, 9),
                                              type: 'image',
                                              x: item.x + item.width + 50,
                                              y: item.y,
                                              width: imgObj.width / 2,
                                              height: imgObj.height / 2,
                                              zIndex: topZ + 2,
                                              parentId: item.id, // LINK TO EDITOR NODE
                                              src: imgUrl
                                          };
                                          setTopZ(prev => prev + 2);
                                          setItems(prev => [...prev, newItem]);
                                          setSelectedIds(new Set([newItem.id])); // Select new
                                          updateItemData(itemId, { isGenerating: false, progress: 100 });
                                      };
                                  }
                                  return;
                              }
                          }
                      } else if (result.status.status_str === 'error') {
                          throw new Error('Generation Failed');
                      }
                  }

                  // Update progress
                  const logs = await getLogs(url);
                  const parsed = parseConsoleProgress(logs, 20);
                  const currentProg = item.type === 'generator' ? item.data.progress : item.data.progress;
                  const newProg = parsed > 0 ? parsed : Math.min(currentProg + 2, 95);
                  
                  updateItemData(itemId, { progress: newProg });
                  setTimeout(checkStatus, 1000);
              } catch (e) {
                  console.error(e);
                  updateItemData(itemId, { isGenerating: false, progress: 0 }); 
              }
          };

          checkStatus();

      } catch (e: any) {
          alert(e.message);
          updateItemData(itemId, { isGenerating: false, progress: 0 });
      }
  };


  // --- Renderers ---

  const renderConnections = () => {
      const connections: React.ReactElement[] = [];
      const drawnConnections = new Set<string>(); // avoid duplicates

      items.forEach(item => {
          if (item.parentId) {
              const parent = items.find(i => i.id === item.parentId);
              if (parent) {
                  const key = `${parent.id}-${item.id}`;
                  if (!drawnConnections.has(key)) {
                      drawnConnections.add(key);
                      
                      const parentCenter = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
                      const itemCenter = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
                      
                      const isActive = selectedIds.has(item.id) || selectedIds.has(parent.id);

                      connections.push(
                          <line 
                              key={key}
                              x1={parentCenter.x} y1={parentCenter.y}
                              x2={itemCenter.x} y2={itemCenter.y}
                              stroke="#3b82f6"
                              strokeWidth={isActive ? "2" : "1"}
                              strokeDasharray="8,8"
                              className={`connection-line ${isActive ? 'opacity-100' : 'opacity-30'}`}
                          />
                      );
                  }
              }
          }
      });
      
      if (connections.length === 0) return null;

      return (
          <svg className="absolute top-0 left-0 pointer-events-none overflow-visible" style={{ width: 1, height: 1, zIndex: 0 }}>
              {connections}
          </svg>
      );
  };

  const renderEditOverlay = (id: string, isEditing: boolean, progress: number, prompt: string | undefined, onPromptChange: (val: string) => void, onExecute: () => void) => (
      <div 
        className={`absolute bottom-4 left-4 right-4 transition-all duration-300 z-50 ${isEditing ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100'}`}
        onMouseDown={e => e.stopPropagation()}
      >
          <div className="glass-panel p-2 rounded-xl flex items-center gap-2 shadow-xl border border-white/50 bg-white/60 backdrop-blur-md">
              <input 
                  type="text" 
                  className="flex-1 bg-transparent border-none text-xs font-medium text-slate-800 placeholder:text-slate-500 focus:outline-none px-2"
                  placeholder="Modify this image (e.g., 'add sunglasses')..."
                  value={prompt || ''}
                  onChange={e => onPromptChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && onExecute()}
              />
              <button 
                  onClick={onExecute}
                  disabled={isEditing || !prompt}
                  className="bg-slate-800 text-white rounded-lg p-1.5 hover:bg-black transition-colors disabled:opacity-50"
              >
                  {isEditing ? (
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                  )}
              </button>
          </div>
          {isEditing && (
              <div className="absolute -top-2 left-0 w-full h-1 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}></div>
              </div>
          )}
      </div>
  );

  const renderImageNode = (item: ImageItem) => (
      <div 
        className="relative group w-full h-full rounded-2xl shadow-sm hover:shadow-2xl transition-all duration-300 select-none"
      >
          {/* Main Image */}
          <img 
            src={item.src} 
            alt="uploaded" 
            className="w-full h-full object-cover rounded-2xl pointer-events-none select-none bg-white"
          />
          
          {/* Close Button Override for visual consistency */}
           <button 
             className="absolute -top-3 -right-3 z-50 bg-white text-red-500 p-1.5 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 hover:scale-110"
             onClick={(e) => removeItem(item.id, e)}
             onMouseDown={e => e.stopPropagation()}
           >
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
           </button>

          {/* Edit Overlay */}
          {renderEditOverlay(
              item.id, 
              !!item.isEditing, 
              item.editProgress || 0, 
              item.editPrompt, 
              (val) => updateImageItem(item.id, { editPrompt: val }),
              () => executeEdit(item.id, item.editPrompt || '')
          )}

          {/* Download Icon (Top Left) */}
          <a 
              href={item.src} 
              download={`img-${item.id}.png`}
              className="absolute top-2 left-2 p-2 bg-black/20 text-white rounded-full opacity-0 group-hover:opacity-100 backdrop-blur-sm hover:bg-black/40 transition-all"
              onClick={e => e.stopPropagation()}
          >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </a>
      </div>
  );

  const renderGeneratorNode = (item: GeneratorItem) => {
      const isInput = item.data.mode === 'input';

      return (
        <div 
          className="relative group w-full h-full flex flex-col transition-all duration-300"
          onMouseDown={e => {
            // If clicking strictly on the container (padding area), allow drag
            // Stop propagation only if clicking interactive elements
            if ((e.target as HTMLElement).tagName === 'TEXTAREA') {
               e.stopPropagation();
            }
          }}
        >
            {/* Top Hover Controls */}
            {isInput && (
                <div className="absolute bottom-full left-0 w-full flex justify-center pb-4 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-y-2 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50">
                    <div className="flex items-center gap-2 p-1.5 bg-white/80 backdrop-blur-md rounded-2xl shadow-xl border border-white/50">
                        <button 
                            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all ${item.data.model === 'flux' ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
                            onClick={() => updateItemData(item.id, { model: 'flux' })}
                        >
                            FLUX
                        </button>
                        <button 
                            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all ${item.data.model === 'sdxl' ? 'bg-purple-600 text-white shadow-md' : 'text-slate-500 hover:bg-slate-100'}`}
                            onClick={() => updateItemData(item.id, { model: 'sdxl' })}
                        >
                            SDXL
                        </button>
                        <div className="w-[1px] h-4 bg-slate-300 mx-1"></div>
                        
                        {/* SIZE CONTROLS WITH PRESETS */}
                        <div className="relative flex items-center gap-1 px-2 size-menu-container">
                            <button 
                                className="text-[10px] font-bold text-slate-400 hover:text-primary transition-colors flex items-center gap-1"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setActiveSizeMenuId(activeSizeMenuId === item.id ? null : item.id);
                                }}
                            >
                                SIZE
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6"/></svg>
                            </button>
                            
                            <input 
                                className="w-12 bg-transparent border-b border-slate-300 text-xs text-center focus:outline-none" 
                                value={item.data.width} 
                                onChange={e => updateItemData(item.id, { width: Number(e.target.value) })}
                            />
                            <span className="text-[10px] text-slate-300">x</span>
                            <input 
                                className="w-12 bg-transparent border-b border-slate-300 text-xs text-center focus:outline-none" 
                                value={item.data.height} 
                                onChange={e => updateItemData(item.id, { height: Number(e.target.value) })}
                            />

                            {/* Dropdown Menu - UPDATED: OPEN UPWARDS */}
                            {activeSizeMenuId === item.id && (
                                <div className="absolute bottom-full left-0 mb-2 bg-white rounded-xl shadow-xl border border-slate-100 p-2 z-[60] min-w-[140px] animate-fade-in flex flex-col gap-1 origin-bottom">
                                    <div className="text-[10px] font-bold text-slate-400 px-2 py-1 mb-1">PRESETS</div>
                                    {SIZE_PRESETS.map(preset => (
                                        <button
                                            key={preset.label}
                                            className="text-left px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 rounded-lg hover:text-primary transition-colors flex justify-between items-center group"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                updateItemData(item.id, { width: preset.w, height: preset.h });
                                                setActiveSizeMenuId(null);
                                            }}
                                        >
                                            <span>{preset.label}</span>
                                            <span className="text-[9px] text-slate-300 group-hover:text-primary/50">{preset.w}x{preset.h}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Main Container */}
            <div className={`w-full h-full glass-panel rounded-3xl overflow-hidden shadow-sm hover:shadow-2xl transition-all duration-300 border border-white/60 relative ${item.data.isGenerating ? 'ring-4 ring-primary/30' : ''}`}>
                
                {item.data.isGenerating && (
                    <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center">
                        <div className="w-16 h-16 border-4 border-slate-200 border-t-primary rounded-full animate-spin mb-4"></div>
                        <span className="text-sm font-bold text-slate-600 animate-pulse">{item.data.progress}% Generatng...</span>
                    </div>
                )}

                {isInput ? (
                    <div className="w-full h-full p-6 flex flex-col">
                         <textarea 
                            className="flex-1 w-full bg-transparent text-2xl font-medium text-slate-700 placeholder:text-slate-300 resize-none focus:outline-none text-center pt-20 leading-relaxed"
                            placeholder={item.data.model === 'flux' ? "Imagine something wonderful..." : "Describe your SDXL prompt..."}
                            value={item.data.prompt}
                            onChange={(e) => updateItemData(item.id, { prompt: e.target.value })}
                        />
                        {item.data.model === 'sdxl' && (
                            <input 
                                className="w-full bg-transparent border-t border-slate-200/50 py-3 text-sm text-slate-500 placeholder:text-slate-300 focus:outline-none text-center"
                                placeholder="Negative prompt (optional)"
                                value={item.data.negPrompt}
                                onChange={(e) => updateItemData(item.id, { negPrompt: e.target.value })}
                            />
                        )}
                    </div>
                ) : (
                    <div className="w-full h-full relative group/image">
                        <img src={item.data.resultImage} className="w-full h-full object-cover pointer-events-none select-none" alt="result" />
                        
                        {/* Edit Overlay for Generator Result */}
                        {renderEditOverlay(
                            item.id, 
                            !!item.data.isEditing, 
                            item.data.editProgress || 0, 
                            item.data.editPrompt, 
                            (val) => updateItemData(item.id, { editPrompt: val }),
                            () => executeEdit(item.id, item.data.editPrompt || '')
                        )}

                        {/* Top Controls */}
                        <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-all">
                             <button 
                                onClick={() => updateItemData(item.id, { mode: 'input' })}
                                className="bg-black/20 text-white p-2 rounded-full backdrop-blur-sm hover:bg-black/40"
                                title="Back to Prompt"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                            </button>
                            <a 
                                href={item.data.resultImage} 
                                download={`gen-${item.id}.png`}
                                className="bg-black/20 text-white p-2 rounded-full backdrop-blur-sm hover:bg-black/40"
                                onClick={e => e.stopPropagation()}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            </a>
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom Hover Controls (Generate Button) */}
            {isInput && !item.data.isGenerating && (
                <div className="absolute top-full left-0 w-full flex justify-center pt-6 opacity-0 group-hover:opacity-100 transition-all duration-300 transform -translate-y-2 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50">
                    <button 
                        onClick={() => executeGeneration(item.id)}
                        className="bg-gradient-to-r from-primary to-blue-600 text-white px-8 py-3 rounded-full shadow-lg shadow-blue-500/30 font-bold tracking-wide hover:shadow-blue-500/50 hover:scale-105 active:scale-95 transition-all flex items-center gap-2"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                        GENERATE
                    </button>
                </div>
            )}
        </div>
      );
  };

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
            className={`absolute inset-0 canvas-bg ${isSpacePressed ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
              <div 
                className="absolute origin-top-left will-change-transform"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              >
                  {/* Connection Lines Layer (Behind items) */}
                  {renderConnections()}

                  {items.map(item => (
                      <div
                        key={item.id}
                        className={`absolute group transition-shadow duration-200 rounded-2xl ${
                            selectedIds.has(item.id) 
                            ? 'ring-4 ring-blue-500/50 shadow-2xl z-20' 
                            : activeItemId === item.id 
                                ? 'ring-2 ring-blue-400/30 shadow-xl' 
                                : 'hover:ring-2 hover:ring-blue-400/10'
                        }`}
                        style={{
                            left: item.x,
                            top: item.y,
                            width: item.width,
                            height: item.height,
                            zIndex: item.zIndex,
                        }}
                        onMouseDown={(e) => handleItemMouseDown(e, item.id)}
                      >
                          {/* Close Button Override for visual consistency */}
                           <button 
                             className={`absolute -top-3 -right-3 z-50 bg-white text-red-500 p-1.5 rounded-full shadow-lg opacity-0 transition-opacity hover:bg-red-50 hover:scale-110 ${activeItemId === item.id || selectedIds.has(item.id) ? 'opacity-100' : 'group-hover:opacity-100'}`}
                             onClick={(e) => removeItem(item.id, e)}
                             onMouseDown={e => e.stopPropagation()}
                          >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                          </button>

                          {/* Content */}
                          {item.type === 'image' && renderImageNode(item as ImageItem)}
                          {item.type === 'generator' && renderGeneratorNode(item as GeneratorItem)}
                          {item.type === 'editor' && renderEditNode(item as EditorItem)}
                      </div>
                  ))}
                  
                  {items.length === 0 && (
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-300 font-light text-2xl select-none pointer-events-none text-center animate-pulse">
                          Click + to start creating<br/>
                          <span className="text-sm mt-2 block opacity-70">Space + Drag to Pan</span>
                      </div>
                  )}
              </div>
              
              {/* Selection Box Overlay */}
              {selectionBox && (
                  <div 
                      className="absolute border border-blue-500 bg-blue-500/10 pointer-events-none z-50"
                      style={{
                          left: Math.min(selectionBox.startX, selectionBox.currentX),
                          top: Math.min(selectionBox.startY, selectionBox.currentY),
                          width: Math.abs(selectionBox.currentX - selectionBox.startX),
                          height: Math.abs(selectionBox.currentY - selectionBox.startY)
                      }}
                  />
              )}
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
      <style>{`
          @keyframes dashFlow {
              from { stroke-dashoffset: 24; }
              to { stroke-dashoffset: 0; }
          }
          .connection-line {
              animation: dashFlow 1s linear infinite;
          }
      `}</style>
    </div>
  );
};

export default InfiniteCanvasTab;