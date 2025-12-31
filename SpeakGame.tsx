
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Memorization, Token } from '../../types';
import { tokenizeText } from '../../utils';
import { Card, Button, Modal } from '../Layout';
import { 
  Mic, Square, Check, AlertCircle, Loader2, 
  Edit2, Play, Pause, ChevronLeft,
  ChevronRight, Star, Lightbulb, CheckCircle2,
  TrendingUp, RotateCcw, Zap, Activity, X, Trash2, Save, Timer, RefreshCw, Brain,
  ArrowRightCircle, ArrowLeft, Home
} from 'lucide-react';
import { useAppStore } from '../../store';
import { GoogleGenAI } from '@google/genai';

type GameStep = 'setup' | 'practice' | 'processing' | 'correction' | 'results';
type DifficultyLevel = 1 | 2; 

interface TextSegment {
  title: string;
  text: string;
}

interface ChunkResult {
  index: number;
  expected: string;
  spoken: string;
  accuracy: number;
  missedWords: string[];
  closeMatch?: boolean;
  duration: number;
  level: number;
}

interface LevelSummary {
    accuracy: number;
    time: number;
    completed: boolean;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^\w]/g, '');
const isMatch = (expected: string, spoken: string): boolean => {
  const e = normalize(expected);
  const s = normalize(spoken);
  if (!e || !s) return false;
  return e === s;
};

interface GameProps {
    data: Memorization;
    onComplete: (s: number) => void;
    guideOpen: boolean;
    onGuideClose: () => void;
}

export const SpeakGame: React.FC<GameProps> = ({ data, onComplete, guideOpen, onGuideClose }) => {
  const { notepageMode } = useAppStore();
  const navigate = useNavigate();

  // --- Main State ---
  const [step, setStep] = useState<GameStep>('setup');
  const [level, setLevel] = useState<DifficultyLevel>(1);
  
  // --- Selection State ---
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0])); 

  // --- Session Tracking ---
  const [levelSummaries, setLevelSummaries] = useState<Record<number, LevelSummary>>({
      1: { accuracy: 0, time: 0, completed: false },
      2: { accuracy: 0, time: 0, completed: false }
  });

  // --- Practice State ---
  const [chunks, setChunks] = useState<string[]>([]);
  const [currentChunkIdx, setCurrentChunkIdx] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  
  // --- Audio / Recorder State ---
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);

  // --- Verification State ---
  const [reviewItems, setReviewItems] = useState<{ original: string, spoken: string, editing: boolean }[]>([]);

  // --- Results Tracking ---
  const [sessionResults, setSessionResults] = useState<ChunkResult[]>([]);

  // --- UI State ---
  const [loadingMessageIdx, setLoadingMessageIdx] = useState(0);
  const loadingMessages = [
    "Processing audio frequencies...",
    "Verifying memory accuracy...",
    "Finalizing results..."
  ];

  useEffect(() => {
    const naturalBlocks = data.text.split(/\n+/).filter(p => p.trim().length > 0);
    const finalSegments: TextSegment[] = [];

    naturalBlocks.forEach((block, bIdx) => {
      const words = block.split(/\s+/).filter(w => w.length > 0);
      if (words.length <= 150) {
        finalSegments.push({
          title: `Paragraph ${bIdx + 1} (${words.length} words • ~90s)`,
          text: block
        });
      } else {
        const sentences = block.match(/[^.!?]+[.!?]+|\s*[^.!?]+/g) || [block];
        let currentText = "";
        let currentWordCount = 0;
        let partChar = 'A';

        sentences.forEach((sentence) => {
          const sWords = sentence.split(/\s+/).filter(w => w.length > 0).length;
          if (currentWordCount + sWords > 150 && currentWordCount > 0) {
            finalSegments.push({
              title: `Paragraph ${bIdx + 1} (Part ${partChar}) (${currentWordCount} words • ~90s)`,
              text: currentText.trim()
            });
            currentText = sentence;
            currentWordCount = sWords;
            partChar = String.fromCharCode(partChar.charCodeAt(0) + 1);
          } else {
            currentText += (currentText ? " " : "") + sentence;
            currentWordCount += sWords;
          }
        });
        if (currentText) {
          finalSegments.push({
            title: `Paragraph ${bIdx + 1} (Part ${partChar}) (${currentWordCount} words • ~90s)`,
            text: currentText.trim()
          });
        }
      }
    });

    setSegments(finalSegments);
    setSelectedIndices(new Set(finalSegments.map((_, i) => i)));
  }, [data.text]);

  useEffect(() => {
    if (step === 'processing') {
      const interval = setInterval(() => {
        setLoadingMessageIdx((prev) => (prev + 1) % loadingMessages.length);
      }, 800);
      return () => clearInterval(interval);
    }
  }, [step]);

  useEffect(() => {
    let interval: number;
    if (isRecording && !isPaused) {
      interval = window.setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  const formatTimer = (total: number) => {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getMaskedHint = (text: string) => {
    return text.split(/\s+/).map((word) => {
      if (word.length === 0) return word;
      return word[0] + word.slice(1).replace(/[a-zA-Z0-9]/g, '_');
    }).join(' ');
  };

  const playFeedbackSound = (type: 'start' | 'stop') => {
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.connect(g).connect(ctx.destination);
    if (type === 'start') {
      osc.type = 'sine'; osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);
      g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
      if (navigator.vibrate) navigator.vibrate(50);
    } else {
      osc.type = 'sine'; osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.1);
      g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    }
    osc.start(); osc.stop(ctx.currentTime + 0.25);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.readAsDataURL(blob);
    });
  };

  const toggleSelection = (index: number) => {
    const newSet = new Set(selectedIndices);
    if (newSet.has(index)) newSet.delete(index);
    else newSet.add(index);
    setSelectedIndices(newSet);
  };

  const toggleAll = () => {
    if (selectedIndices.size === segments.length) setSelectedIndices(new Set());
    else setSelectedIndices(new Set(segments.map((_, i) => i)));
  };

  const handleStartGame = () => {
    if (selectedIndices.size === 0) return;
    const sortedIndices = Array.from(selectedIndices).sort((a: number, b: number) => a - b);
    const selectedTexts = sortedIndices.map(i => segments[i].text);
    
    setChunks(selectedTexts);
    setCurrentChunkIdx(0);
    setStep('practice');
    setRecordingSeconds(0);
  };

  const startRecording = async () => {
    if (isPaused) { 
        setIsPaused(false); 
        mediaRecorderRef.current?.resume(); 
        if (navigator.vibrate) navigator.vibrate(50);
        return; 
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = processAudioTranscription;
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setIsPaused(false);
      setRecordingSeconds(0);
      playFeedbackSound('start');
    } catch (err) { alert("Microphone access denied."); }
  };

  const pauseRecording = () => { 
      if (mediaRecorderRef.current && isRecording) { 
          mediaRecorderRef.current.pause(); 
          setIsPaused(true); 
          if (navigator.vibrate) navigator.vibrate(200);
      } 
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);
      setIsPaused(false);
      playFeedbackSound('stop');
    }
  };

  const handleSquareClick = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
    setIsRecording(false);
    setIsPaused(false);
    setRecordingSeconds(0);
    audioChunksRef.current = [];
  };

  const retakeChunk = () => {
      if (mediaRecorderRef.current && isRecording) {
          mediaRecorderRef.current.stop();
          mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      }
      setIsRecording(false); setIsPaused(false); setRecordingSeconds(0);
      audioChunksRef.current = [];
      if (step === 'correction') setStep('practice');
  };

  const processAudioTranscription = async () => {
    setStep('processing');
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const base64Audio = await blobToBase64(audioBlob);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{
            parts: [
              { inlineData: { mimeType: 'audio/webm', data: base64Audio } },
              { text: "TRANSCRIPTION MODE: You are a Zero-Error Literal Transducer. Output ONLY the literal spoken words. If you hear silence, static, background noise, or no clear speech, return an empty string. NO punctuation, NO capitalization." }
            ]
        }]
      });
      const rawText = (response.text || "").trim();
      const isBlacklisted = /empty string|no spoken words|identified|transcription|provided|unintelligible|silence|background noise|quick brown fox/i.test(rawText);
      const expectedWords = tokenizeText(chunks[currentChunkIdx]).filter(t => t.isWord).map(t => t.text);
      const spokenWordsRaw = rawText.split(/\s+/).filter(w => w.length > 0);
      const hasOverlap = spokenWordsRaw.some(sw => expectedWords.some(ew => normalize(ew) === normalize(sw)));
      const transcription = (hasOverlap && !isBlacklisted) ? rawText : "";
      const spokenWords = transcription.trim().split(/\s+/).filter(w => w.length > 0);
      const items = expectedWords.map((word, i) => ({ original: word, spoken: spokenWords[i] || "...", editing: false }));
      setReviewItems(items);
      setStep('correction');
    } catch (error) {
      console.error("Transcription error:", error);
      alert("Neural Analysis failed. Please check your connection.");
      setStep('practice');
    }
  };

  const updateReviewWord = (index: number, newVal: string) => { setReviewItems(prev => prev.map((item, i) => i === index ? { ...item, spoken: newVal, editing: false } : item)); };

  const toggleEditWord = (index: number) => {
    const isOpening = !reviewItems[index].editing;
    setReviewItems(prev => prev.map((item, i) => i === index ? { ...item, editing: isOpening } : item));
    if (isOpening) { setTimeout(() => { document.getElementById(`edit-item-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150); }
  };

  const handleFinishChunk = () => {
    let correctCount = 0;
    const missed: string[] = [];
    const wasSilent = reviewItems.every(item => item.spoken === "...");
    reviewItems.forEach(item => { if (isMatch(item.original, item.spoken)) correctCount++; else if (!wasSilent) missed.push(item.original); });
    const chunkAccuracy = Math.round((correctCount / reviewItems.length) * 100);
    const result: ChunkResult = { index: currentChunkIdx, expected: chunks[currentChunkIdx], spoken: reviewItems.map(i => i.spoken).join(' '), accuracy: chunkAccuracy, missedWords: missed, duration: recordingSeconds, level: level };
    const newResults = [...sessionResults, result];
    setSessionResults(newResults);
    if (currentChunkIdx < chunks.length - 1) { setCurrentChunkIdx(prev => prev + 1); setStep('practice'); setRecordingSeconds(0); }
    else {
      const levelResults = newResults.filter(r => r.level === level);
      const avgAcc = Math.round(levelResults.reduce((a, b) => a + b.accuracy, 0) / levelResults.length);
      const totalTime = levelResults.reduce((a, b) => a + b.duration, 0);
      const newSummaries = { ...levelSummaries, [level]: { accuracy: avgAcc, time: totalTime, completed: true } };
      setLevelSummaries(newSummaries);
      const finalAvg = Math.round((newSummaries[1].accuracy + newSummaries[2].accuracy) / (newSummaries[2].completed ? 2 : 1));
      onComplete(finalAvg);
      setStep('results');
    }
  };

  const renderContent = () => {
    if (step === 'setup') {
      return (
        <div className="flex flex-col h-full bg-canvas">
          <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-40">
            <div className="flex items-center gap-4 mb-2 px-1">
                <div className="w-12 h-12 bg-primary-50 rounded-2xl flex items-center justify-center shrink-0">
                  <Mic size={24} className="text-primary-600" />
                </div>
                <div className="text-left">
                  <h2 className="text-xl font-bold text-content leading-tight">Recite Setup</h2>
                  <p className="text-xs text-content-muted">Select paragraphs and recall level.</p>
                </div>
            </div>

            <div className="bg-card p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between cursor-pointer hover:bg-canvas" onClick={toggleAll}>
               <div className="flex items-center gap-3">
                 <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${selectedIndices.size === segments.length ? 'bg-primary-600 border-primary-600' : 'border-gray-300'}`}>
                   {selectedIndices.size === segments.length && <Check size={14} className="text-white" />}
                 </div>
                 <span className="font-bold text-content text-sm uppercase tracking-wider">The Whole Thing</span>
               </div>
            </div>

            {segments.map((seg, idx) => (
               <div key={idx} className="bg-card p-4 rounded-xl shadow-sm border border-gray-100 flex items-start gap-3 cursor-pointer hover:bg-canvas" onClick={() => toggleSelection(idx)}>
                 <div className={`w-5 h-5 rounded border flex items-center justify-center mt-1 shrink-0 transition-colors ${selectedIndices.has(idx) ? 'bg-primary-600 border-primary-600' : 'border-gray-300'}`}>
                   {selectedIndices.has(idx) && <Check size={14} className="text-white" />}
                 </div>
                 <div className="flex-1 min-w-0">
                   <div className="flex justify-between items-center mb-1">
                      <span className="font-bold text-content text-xs uppercase tracking-tight">{seg.title}</span>
                   </div>
                   {/* SHOW 2 LINES OF PREVIEW */}
                   <p className="text-sm text-content-muted line-clamp-2 italic">{seg.text}</p>
                 </div>
               </div>
            ))}
          </div>

          <div className="bg-card border-t border-gray-100 p-6 shrink-0 z-20 shadow-2xl">
              <div className="max-w-md mx-auto space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-content-muted uppercase tracking-[0.2em] block mb-3 text-center">Difficulty</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button onClick={() => setLevel(1)} className={`py-4 rounded-xl border-2 font-bold text-xs transition-all flex flex-col items-center gap-1 ${level === 1 ? 'border-primary-600 bg-primary-50 text-primary-600 shadow-sm' : 'border-gray-100 bg-gray-50 text-gray-400'}`}>
                        <span>Level 1</span>
                        <span className="text-[9px] opacity-60 uppercase font-black">Partial Hints</span>
                      </button>
                      <button onClick={() => setLevel(2)} className={`py-4 rounded-xl border-2 font-bold text-xs transition-all flex flex-col items-center gap-1 ${level === 2 ? 'border-primary-600 bg-primary-50 text-primary-600 shadow-sm' : 'border-gray-100 bg-gray-50 text-gray-400'}`}>
                        <span>Level 2</span>
                        <span className="text-[9px] opacity-60 uppercase font-black">Pure Recall</span>
                      </button>
                    </div>
                  </div>
                  <Button onClick={handleStartGame} disabled={selectedIndices.size === 0} className="w-full py-4 text-lg font-bold shadow-xl rounded-2xl flex items-center justify-center gap-2">
                    START SESSION <ArrowRightCircle size={22} />
                  </Button>
              </div>
          </div>
        </div>
      );
    }

    if (step === 'practice') {
      const progress = Math.round(((currentChunkIdx) / chunks.length) * 100);
      const hintText = getMaskedHint(chunks[currentChunkIdx]);

      return (
        <div className="flex flex-col h-full bg-canvas relative overflow-hidden">
          <div className="shrink-0 px-4 py-1.5 bg-white border-b border-gray-100 flex items-center z-10">
            <button onClick={() => setStep('setup')} className="p-1.5 -ml-1 text-content">
              <ChevronLeft size={22} />
            </button>
            <div className="flex-1 ml-3">
              <div className="flex items-center justify-between mb-0.5">
                 <span className="text-[9px] font-black text-primary-600 uppercase tracking-widest">Level {level}</span>
                 <span className="text-[9px] font-bold text-content-muted uppercase">Para {currentChunkIdx + 1} of {chunks.length}</span>
              </div>
              <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden">
                 <div className="h-full bg-primary-500 transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>
            </div>
          </div>

          <div className="flex-1 p-4 flex flex-col items-center justify-center relative">
              <Card className={`w-full max-w-2xl max-h-[45vh] overflow-y-auto p-10 text-center relative border-gray-100 shadow-md ${notepageMode ? 'notepage-bg' : ''}`}>
                  <div className="text-xl font-medium text-content leading-relaxed italic select-none">
                      {level === 1 ? hintText : (isRecording ? (isPaused ? "Recording Paused" : "Speaking...") : "Recall from memory")}
                  </div>
              </Card>
              {isRecording && (
                  <div className="mt-4 flex items-center gap-2 px-3 py-1 bg-white border border-red-100 rounded-full shadow-sm">
                      <div className={`w-2 h-2 bg-red-500 rounded-full ${isPaused ? '' : 'animate-pulse'}`} />
                      <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">{isPaused ? 'Paused' : 'Recording'}</span>
                  </div>
              )}
          </div>

          <div className="bg-card border-t border-gray-100 p-6 shrink-0 z-20 flex flex-col items-center gap-6 shadow-2xl">
              <div className="flex items-center gap-2 px-4 py-1 bg-white border border-gray-200 rounded-full shadow-sm">
                  <Timer size={14} className={isRecording && !isPaused ? "text-primary-600" : "text-gray-400"} />
                  <span className="text-sm font-mono font-bold text-content tabular-nums">{formatTimer(recordingSeconds)}</span>
              </div>

              <div className="flex items-center gap-6">
                  <button onClick={handleSquareClick} className="w-12 h-12 rounded-full border-2 border-gray-100 text-gray-400 hover:text-red-500 transition-all flex items-center justify-center">
                      <RotateCcw size={20} />
                  </button>

                  <button 
                      onClick={isRecording && !isPaused ? pauseRecording : startRecording}
                      className={`w-20 h-20 rounded-full text-white shadow-2xl flex items-center justify-center transition-all ring-8 ${
                          isRecording && !isPaused ? 'bg-amber-500 ring-amber-50' : 'bg-primary-600 ring-primary-50'
                      }`}
                  >
                      {isRecording && !isPaused ? <Pause size={36} fill="white" /> : <Mic size={36} fill="white" />}
                  </button>

                  <button 
                      onClick={stopRecording}
                      disabled={!isRecording && recordingSeconds === 0}
                      className={`w-14 h-14 rounded-full border-2 transition-all flex items-center justify-center ${
                          isRecording || recordingSeconds > 0 
                              ? 'border-green-100 text-green-600 bg-green-50 shadow-sm' 
                              : 'border-gray-100 text-gray-200 cursor-not-allowed'
                      }`}
                  >
                      <Check size={28} strokeWidth={3} />
                  </button>
              </div>
              
              <span className="text-[10px] font-black text-content-muted uppercase tracking-[0.2em] mb-2">
                  {isRecording ? (isPaused ? "RESUME RECORDING" : "TAP TO PAUSE OR FINISH") : "TAP MIC TO START"}
              </span>
          </div>
        </div>
      );
    }

    if (step === 'processing') {
      return (
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-canvas">
              <style>{`
                @keyframes waveform { 0%, 100% { height: 10px; } 50% { height: 40px; } }
                .wave-bar { animation: waveform 1s ease-in-out infinite; }
                @keyframes brain-pulse { 0% { transform: scale(1); opacity: 0.5; } 50% { transform: scale(1.1); opacity: 1; } 100% { transform: scale(1); opacity: 0.5; } }
                .neural-pulse { animation: brain-pulse 2s ease-in-out infinite; }
              `}</style>
              <div className="relative mb-12">
                 <div className="p-8 rounded-full bg-primary-50 neural-pulse">
                    <Brain size={64} className="text-primary-600" />
                 </div>
              </div>
              <div className="flex items-center gap-1.5 h-10 mb-8">
                  {[1, 2, 3, 4, 5, 6].map(i => (
                    <div key={i} className="w-1.5 bg-primary-400 rounded-full wave-bar" style={{ animationDelay: `${i * 0.1}s` }} />
                  ))}
              </div>
              <div className="text-center space-y-2">
                <h2 className="text-xl font-bold text-content">{loadingMessages[loadingMessageIdx]}</h2>
              </div>
          </div>
      );
    }

    if (step === 'correction') {
      const accuracy = Math.round((reviewItems.filter(i => isMatch(i.original, i.spoken)).length / reviewItems.length) * 100);
      return (
        <div className="flex flex-col h-full bg-canvas">
          <div className="shrink-0 px-4 py-3 bg-white border-b border-gray-100 flex items-center justify-between z-20">
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-2">
                  <div className={`text-xl font-black ${accuracy >= 80 ? 'text-green-600' : 'text-primary-600'}`}>{accuracy}%</div>
                  <span className="text-[10px] font-black text-content-muted uppercase tracking-widest">Accuracy</span>
               </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-40">
            {reviewItems.map((item, i) => {
              const matches = isMatch(item.original, item.spoken);
              const isMissed = item.spoken === "...";
              return (
                <div key={i} id={`edit-item-${i}`} className={`flex items-center gap-3 p-3 rounded-xl border bg-white transition-all ${matches ? 'border-gray-100' : 'border-red-100 shadow-sm'}`}>
                  <span className="text-[10px] font-mono text-content-muted w-4 shrink-0">{i + 1}.</span>
                  <div className="flex-1 min-w-0 grid grid-cols-2 items-center">
                      <span className="text-sm font-semibold text-content truncate">{item.original}</span>
                      <div className="flex items-center gap-2 justify-end">
                          <ChevronRight size={14} className="text-gray-300" />
                          {item.editing ? (
                              <input autoFocus className="w-full max-w-[120px] p-1.5 text-sm border border-primary-500 outline-none rounded-md" defaultValue={item.spoken === "..." ? "" : item.spoken} onBlur={(e) => updateReviewWord(i, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && updateReviewWord(i, e.currentTarget.value)} />
                          ) : (
                              <span className={`text-sm font-bold truncate ${matches ? 'text-green-600' : 'text-red-500'}`}>{isMissed ? '...' : item.spoken}</span>
                          )}
                      </div>
                  </div>
                  <div className="flex items-center gap-1">
                      {!matches && <button onClick={() => toggleEditWord(i)} className="p-2 text-primary-500 hover:bg-primary-50 rounded-lg"><Edit2 size={16} /></button>}
                      {matches && <div className="p-2 text-green-600"><CheckCircle2 size={16} /></div>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bg-card border-t border-gray-100 p-6 shrink-0 z-20 flex gap-3 shadow-2xl">
              <button onClick={retakeChunk} className="px-6 rounded-xl border-2 border-gray-100 text-gray-500 font-bold flex items-center gap-2">
                  <RefreshCw size={18} /> RETAKE
              </button>
              <Button onClick={handleFinishChunk} className="flex-1 py-4 text-lg font-black rounded-xl">
                  {currentChunkIdx < chunks.length - 1 ? 'NEXT' : 'FINISH'}
              </Button>
          </div>
        </div>
      );
    }

    if (step === 'results') {
      const totalMastered = sessionResults.filter(r => r.accuracy >= 90).length;
      const missedWordSet = new Set<string>();
      sessionResults.forEach(r => r.missedWords.forEach(w => missedWordSet.add(w.toLowerCase())));
      const uniqueMissed = Array.from(missedWordSet).slice(0, 10);
      return (
        <div className="flex-1 flex flex-col overflow-y-auto p-6 bg-canvas pb-20">
           <div className="w-full max-w-2xl mx-auto space-y-6">
              <div className="text-center"><h2 className="text-2xl font-black text-content tracking-tight mb-6">Session Results</h2></div>
              <div className="space-y-4">
                 {levelSummaries[level].completed && (
                     <Card className="p-5 border-indigo-100 bg-white shadow-sm">
                        <div>
                            <h3 className="text-lg font-bold text-indigo-800">Recital Mastered</h3>
                            <div className="text-3xl font-black text-primary-600 my-2">{levelSummaries[level].accuracy}% <span className="text-sm font-bold text-content-muted">Avg Accuracy</span></div>
                        </div>
                     </Card>
                 )}
              </div>
              <Card className="p-6 space-y-6 shadow-sm">
                  <div className="border-b border-gray-100 pb-4">
                      <h3 className="text-xs font-black text-content-muted uppercase tracking-[0.2em] mb-4 flex items-center gap-2"><TrendingUp size={14} /> Performance</h3>
                      <div className="grid grid-cols-2 gap-6">
                          <div className="flex items-center gap-3">
                              <div className="p-2 bg-green-50 text-green-600 rounded-lg"><CheckCircle2 size={20} /></div>
                              <div><span className="block text-xl font-bold">{totalMastered}/{chunks.length}</span><span className="text-[10px] font-bold text-green-600 uppercase">Paras Done</span></div>
                          </div>
                      </div>
                  </div>
                  {uniqueMissed.length > 0 && (<div className="space-y-3"><h3 className="text-xs font-black text-content-muted uppercase tracking-[0.2em]">Words to Review</h3><div className="flex flex-wrap gap-2">{uniqueMissed.map(w => (<span key={w} className="px-3 py-1 bg-red-50 text-red-700 text-[10px] font-bold rounded-full border border-red-100 capitalize">{w}</span>))}</div></div>)}
              </Card>
              <div className="grid grid-cols-2 gap-4 pt-4">
                  <button onClick={() => setStep('setup')} className="py-4 font-black uppercase text-xs tracking-widest border-2 rounded-xl text-content-muted flex items-center justify-center gap-2"><RotateCcw size={14} /> RETAKE</button>
                  <Button onClick={() => navigate(`/game/${data.id}`)} className="py-4 font-black uppercase text-xs tracking-widest shadow-xl rounded-xl">FINISH</Button>
              </div>
           </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col h-full bg-canvas overflow-hidden">
      {renderContent()}

      <Modal isOpen={showMicError} onClose={() => setShowMicError(false)} title="Microphone Error">
        <div className="flex flex-col items-center text-center p-2 space-y-5">
           <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center shadow-inner">
              <MicOff size={32} />
           </div>
           <div>
              <h3 className="text-xl font-bold text-slate-800">Microphone Access Required</h3>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                Recallix needs microphone access to verify your recital. Please enable it in your browser settings and try again.
              </p>
           </div>
           <Button onClick={() => setShowMicError(false)} className="w-full py-3 font-bold">
              I've Enabled It
           </Button>
        </div>
      </Modal>

      <Modal isOpen={guideOpen} onClose={onGuideClose} title="What is Recite?">
          <div className="flex flex-col">
             <div className="flex items-center gap-4 mb-6"><div className="w-14 h-14 bg-red-50 text-red-600 rounded-full flex items-center justify-center shrink-0"><Mic size={28} /></div><p className="text-base text-content-muted leading-relaxed text-left">The ultimate recall test. Speak the text aloud and let the neural engine verify your accuracy.</p></div>
             <ul className="space-y-4 mb-8"><li className="flex items-start gap-3 text-sm text-content-muted font-medium text-left"><span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0 mt-1.5" /><span>Select specific paragraphs to focus on.</span></li><li className="flex items-start gap-3 text-sm text-content-muted font-medium text-left"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 shrink-0 mt-1.5" /><span>Record your recital. Neural analysis will flag missed words.</span></li></ul>
          </div>
      </Modal>
    </div>
  );
};

export default SpeakGame;
