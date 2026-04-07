import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Volume2, VolumeX, Home, Layout, IndianRupee, Info, ExternalLink, Sparkles } from "lucide-react";
import { floatTo16BitPCM, base64ToArrayBuffer } from "../lib/audio-utils";

const SYSTEM_INSTRUCTION = `You are "Interior Jarvis", a premium Indian interior design budget assistant.
Tone: Warm, professional, snappy.
Language: Hinglish (Natural Indian English).

CRITICAL: Follow this step-by-step flow strictly. Do not ask multiple questions at once.

Flow:
1. Greet + Ask Space Type: "Namaste! Interior Jarvis here. Interior budget jaanne ke liye kripya apna space type batateyin? (1BHK, 2BHK, 3BHK, villa, bedroom, kitchen, bathroom, living area, face, office, ya restaurant?)"
2. Wait for answer.
3. Ask Carpet Area: "Aapka carpet area kitna hai?"
4. Wait for answer.
5. Ask City: "Aap kaunse city se hain?"
6. Wait for answer.
7. Provide 'standard' budget estimates specific to the city provided.
   - If the user specifically asks for 'premium', 'luxury', or 'basic' budgets, provide those estimates instead.
   - Always ensure estimates are realistic for the city provided.
8. CTA: "Agar aap hamare verified interior designer se complete guidance chahte hain, to reply kare Yes or No."

If user says "Yes", say: "Thik hai sir, main niche Book Now button show kara rahi hoon, aap form fill karein."
If user says "No": Terminate conversation politely.

Rules:
- ONLY talk about budget.
- If the user asks about space planning, design ideas, or expert advice, politely say: "In sabhi cheezon ke liye aap hamare interior designer ko book kar sakte hain, main sirf budget estimate mein aapki madad kar sakta hoon."
- Always maintain your consistent Indian accent and professional tone.
- Use Hinglish where appropriate to sound natural and premium.`;

// • Carpet Area Validation:
// If the user provides an unrealistic carpet area for the selected space type, do not proceed.
// Realistic ranges:
// - 1BHK: 300–800 sqft
// - 2BHK: 600–1200 sqft
// - 3BHK: 900–1800 sqft
// - 4BHK: 1200–3000 sqft
// If input is far outside these ranges, politely inform the user and ask for correct input.
// Response: "The carpet area you provided seems unusual for the selected space type. Could you please recheck and enter a realistic area so I can give you an accurate estimate?"
// 
// // • City Validation (India Only):
// // If the city is not in India or is unknown/unrecognized, do NOT proceed.
// // Ask user to provide a valid Indian city or mention their state.
// // Response: "I couldn't recognize the city you entered. Please provide a valid Indian city or mention your state so I can estimate costs accurately."
// 
// // • Behavior Rules:
// // - Be polite and professional.
// - Do not say "wrong input".
// - Use phrases like: "seems unusual", "please recheck", "to give accurate estimate".
// - No Assumptions: Do NOT auto-correct values. Always ask user to confirm correct input.
// - Resume Flow: Once correct input is received, continue the normal process.
// - Priority Rule: Always prioritize accuracy over speed. Never generate estimates based on doubtful or unrealistic inputs.


export default function InteriorJarvis() {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [aiResponse, setAiResponse] = useState<string>("");
  const [showBookNow, setShowBookNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [cachedApiKey, setCachedApiKey] = useState<string | null>(null);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  // Pre-fetch API key on mount to speed up connection
  useEffect(() => {
    getApiKey().then(({ key }) => {
      if (key && key !== "MY_GEMINI_API_KEY") {
        setCachedApiKey(key);
      }
    });
  }, []);

  const checkApiKey = async () => {
    // @ts-ignore
    const aistudio = window.aistudio;
    if (aistudio) {
      try {
        if (!(await aistudio.hasSelectedApiKey())) {
          await aistudio.openSelectKey();
        }
      } catch (e) {
        console.error("Error checking/opening API key dialog:", e);
      }
    }
  };

  const getApiKey = async () => {
    // Try to get key from various sources in order of priority
    let key = "";
    let backendError = "";
    
    // 1. Check window.API_KEY (Platform runtime injection)
    key = (window as any).API_KEY || (window as any).GEMINI_API_KEY;
    
    // 2. Check backend API (Secure way for custom deployments)
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      try {
        console.log("Fetching API key from backend...");
        const response = await fetch("/api/config");
        if (response.ok) {
          const data = await response.json();
          if (data.apiKey) {
            key = data.apiKey;
            console.log("API Key successfully fetched from backend.");
          } else {
            backendError = "Backend returned success but no apiKey field found.";
          }
        } else {
          try {
            const errorData = await response.json();
            backendError = errorData.error || `Status: ${response.status}`;
          } catch (e) {
            backendError = `Status: ${response.status}`;
          }
        }
      } catch (e) {
        backendError = e instanceof Error ? e.message : "Network error";
      }
    }
    
    // 3. Fallbacks
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      try {
        // @ts-ignore
        key = process.env.GEMINI_API_KEY || process.env.API_KEY;
      } catch (e) {}
    }
    
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      const metaEnv = (import.meta as any).env;
      if (metaEnv) {
        key = metaEnv.VITE_GEMINI_API_KEY || metaEnv.VITE_API_KEY || "";
      }
    }
    
    return { key: key || "", error: backendError };
  };

  const startSession = async () => {
    setError(null);
    setIsConnecting(true);
    
    // Start microphone early to save time
    const micPromise = startMic();
    
    try {
      let finalKey = cachedApiKey;
      let fetchErrorMsg = "";
      
      if (!finalKey) {
        const { key: apiKey, error: fetchError } = await getApiKey();
        finalKey = apiKey;
        fetchErrorMsg = fetchError;
      }
      
      // If we have a placeholder or no key, try to open the key selector
      if (!finalKey || finalKey === "MY_GEMINI_API_KEY") {
        await checkApiKey();
        const { key: retryKey, error: retryError } = await getApiKey();
        finalKey = retryKey;
        if (!fetchErrorMsg) fetchErrorMsg = retryError;
      }
      
      // Final check - if still no key, throw a more descriptive error
      if (!finalKey || finalKey === "MY_GEMINI_API_KEY" || finalKey === "") {
        const hostname = window.location.hostname;
        const isPublished = hostname.includes('run.app') || hostname.includes('vercel.app') || (hostname !== 'localhost' && hostname !== '127.0.0.1');
        const hasAiStudio = !!(window as any).aistudio;
        
        if (isPublished && !hasAiStudio) {
          throw new Error(`API Key Missing! 
          Backend Error: ${fetchErrorMsg || "Unknown"}
          
          1. Vercel Dashboard mein 'GEMINI_API_KEY' check karein.
          2. Variable add karne ke baad 'Redeploy' zaroor karein.
          3. Agar aapne .env file use ki hai, toh wo Vercel par kaam nahi karegi.`);
        } else if (hasAiStudio) {
          throw new Error("Please select an API key to start the conversation.");
        } else {
          throw new Error("API Key is missing. Please configure it in the Secrets panel (lock icon) in AI Studio.");
        }
      }

      const ai = new GoogleGenAI({ apiKey: finalKey });
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            systemInstruction: SYSTEM_INSTRUCTION,
            outputAudioTranscription: {},
            inputAudioTranscription: {},
          },
          callbacks: {
            onopen: async () => {
              console.log("Session opened");
              setIsActive(true);
              setIsConnecting(false);
              // Ensure mic is ready
              await micPromise;
              
              // Trigger the agent to start speaking the greeting
              if (sessionRef.current) {
                sessionRef.current.sendRealtimeInput({
                  text: "Hello, please start the conversation by greeting me as instructed."
                });
              }
            },
            onmessage: async (message: LiveServerMessage) => {
              if (message.serverContent?.modelTurn?.parts) {
                const audioPart = message.serverContent.modelTurn.parts.find(p => p.inlineData);
                if (audioPart?.inlineData?.data) {
                  const pcmData = new Int16Array(base64ToArrayBuffer(audioPart.inlineData.data));
                  audioQueueRef.current.push(pcmData);
                  if (!isPlayingRef.current) {
                    playNextInQueue();
                  }
                }
                
                const textPart = message.serverContent.modelTurn.parts.find(p => p.text);
                if (textPart?.text) {
                  const text = textPart.text.toLowerCase();
                  setAiResponse(prev => prev + " " + textPart.text);
                  
                  // If the model is asking for CTA and user says yes/no, it should be handled in inputTranscription.
                  // But if the model itself says something that triggers this, we handle it here.
                }
              }

              if (message.serverContent?.interrupted) {
                audioQueueRef.current = [];
                isPlayingRef.current = false;
              }

              if (message.serverContent?.inputTranscription?.text) {
                const input = message.serverContent.inputTranscription.text.toLowerCase();
                setTranscript(message.serverContent.inputTranscription.text);
                
                if (input.includes("yes") || input.includes("haan") || input.includes("theek hai")) {
                  // Pre-emptively show button if user says yes
                  setShowBookNow(true);
                  // Delay closing to allow model to speak the instruction
                  setTimeout(() => {
                    if (sessionRef.current) {
                      sessionRef.current.close();
                      setIsActive(false);
                    }
                  }, 4000);
                } else if (input.includes("no") || input.includes("nahi")) {
                  if (sessionRef.current) {
                    sessionRef.current.close();
                    setIsActive(false);
                  }
                }
              }
            },
          onclose: () => {
            setIsActive(false);
            setIsConnecting(false);
            stopMic();
          },
          onerror: (err) => {
            console.error("Live API Error:", err);
            setError(`Connection error: ${err?.message || "Please check your internet and API key."}`);
            setIsActive(false);
            setIsConnecting(false);
          }
        }
      });

      sessionRef.current = session;
    } catch (error: any) {
      console.error("Failed to connect:", error);
      setError(error.message || "An unexpected error occurred.");
      setIsConnecting(false);
      stopMic();
    }
  };

  const startMic = async () => {
    try {
      // Create AudioContext synchronously to avoid suspension
      // Use default sample rate for hardware compatibility, then resample if needed
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const source = audioContext.createMediaStreamSource(stream);
      // We still need 16000 for Gemini input, but we'll let ScriptProcessor handle it or just send what we have
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMuted) return;
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Simple downsampling if context rate is not 16000
        let processedData = inputData;
        if (audioContext.sampleRate !== 16000) {
          // Very basic downsampling (skip samples) - not high quality but fast
          const ratio = audioContext.sampleRate / 16000;
          const newLength = Math.round(inputData.length / ratio);
          const result = new Float32Array(newLength);
          for (let i = 0; i < newLength; i++) {
            result[i] = inputData[Math.round(i * ratio)];
          }
          processedData = result;
        }

        const pcmBuffer = floatTo16BitPCM(processedData);
        
        // Faster base64 conversion
        const base64Data = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(pcmBuffer))));
        
        if (sessionRef.current) {
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) {
      console.error("Mic access denied:", error);
      setError("Microphone access denied. Please allow microphone permissions to start the conversation.");
    }
  };

  const stopMic = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    processorRef.current?.disconnect();
    audioContextRef.current?.close();
  };

  const playNextInQueue = async () => {
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    if (!audioContextRef.current) return;

    // Mobile fix: Always try to resume context before playing
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    
    const audioBuffer = audioContextRef.current.createBuffer(1, pcmData.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) {
      channelData[i] = pcmData[i] / 32768;
    }

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    source.onended = playNextInQueue;
    source.start();
  };

  const toggleSession = () => {
    if (isActive) {
      sessionRef.current?.close();
      setIsActive(false);
    } else {
      startSession();
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6 font-sans">
      <div className="max-w-2xl w-full space-y-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex justify-center">
            <div className="relative">
              <div className={`absolute inset-0 bg-gold-500/20 rounded-full blur-3xl transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-0'}`} />
              <div className="relative bg-gradient-to-br from-amber-400 to-amber-600 p-6 rounded-full shadow-2xl">
                <Sparkles className="w-12 h-12 text-black" />
              </div>
            </div>
          </div>
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-amber-200 to-amber-500 bg-clip-text text-transparent">
            Interior Jarvis
          </h1>
          <p className="text-gray-400 text-lg">
            Your Premium Indian Interior Assistant
          </p>
        </motion.div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-8">
          {[
            { icon: Layout, label: "Space Planning" },
            { icon: IndianRupee, label: "Budgeting" },
            { icon: Home, label: "Design Ideas" },
            { icon: Info, label: "Expert Advice" }
          ].map((item, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: idx * 0.1 }}
              className="bg-white/5 border border-white/10 p-4 rounded-2xl flex flex-col items-center space-y-2 hover:bg-white/10 transition-colors"
            >
              <item.icon className="w-6 h-6 text-amber-400" />
              <span className="text-xs font-medium text-gray-300">{item.label}</span>
            </motion.div>
          ))}
        </div>

        <div className="relative h-48 flex items-center justify-center">
          <AnimatePresence mode="wait">
            {!isActive ? (
              <div className="flex flex-col items-center space-y-4">
                <motion.button
                  key="start"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  onClick={toggleSession}
                  disabled={isConnecting}
                  className={`group relative px-8 py-4 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-full transition-all hover:scale-105 active:scale-95 shadow-[0_0_40px_rgba(245,158,11,0.3)] ${isConnecting ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {isConnecting ? "Connecting..." : "Start Conversation"}
                </motion.button>
                {error && (
                  <div className="flex flex-col items-center">
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-red-500 text-sm max-w-xs text-center"
                    >
                      {error}
                    </motion.p>
                    {(window as any).aistudio && (
                      <button 
                        onClick={async () => {
                          setError(null);
                          await (window as any).aistudio.openSelectKey();
                        }}
                        className="mt-2 text-amber-500 underline text-sm font-medium hover:text-amber-400 transition-colors"
                      >
                        Select API Key
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <motion.div
                key="active"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center space-y-6 w-full"
              >
                <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-4 min-h-[80px] flex flex-col justify-center">
                  {transcript && (
                    <p className="text-amber-400 text-sm font-medium mb-2">You: {transcript}</p>
                  )}
                  {aiResponse && (
                    <p className="text-gray-300 text-sm line-clamp-2 italic">Jarvis: {aiResponse.split(' ').slice(-15).join(' ')}...</p>
                  )}
                </div>
                <div className="flex items-center space-x-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <motion.div
                      key={i}
                      animate={{
                        height: [20, 40, 20],
                      }}
                      transition={{
                        duration: 0.5,
                        repeat: Infinity,
                        delay: i * 0.1,
                      }}
                      className="w-1.5 bg-amber-500 rounded-full"
                    />
                  ))}
                </div>
                <div className="flex space-x-4">
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`p-4 rounded-full transition-colors ${isMuted ? 'bg-red-500/20 text-red-500' : 'bg-white/10 text-white'}`}
                  >
                    {isMuted ? <MicOff /> : <Mic />}
                  </button>
                  <button
                    onClick={toggleSession}
                    className="p-4 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                  >
                    <VolumeX />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {showBookNow && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="relative overflow-hidden bg-gradient-to-br from-amber-500/20 to-amber-600/20 border border-amber-500/40 p-8 rounded-[2.5rem] shadow-[0_20px_50px_rgba(245,158,11,0.15)] group"
            >
              <div className="absolute top-0 right-0 p-4">
                <Sparkles className="w-6 h-6 text-amber-400 animate-pulse" />
              </div>
              <div className="space-y-6 relative z-10">
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold text-amber-100">Ready to start your journey?</h3>
                  <p className="text-amber-200/70 font-medium italic">
                    "Hamare verified experts aapka intezar kar rahe hain."
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                  <a
                    href="https://shyamamrit.com/findv/landing-page/enquiry.php"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto inline-flex items-center justify-center space-x-3 px-10 py-4 bg-amber-500 text-black font-bold text-lg rounded-2xl hover:bg-amber-400 transition-all hover:scale-105 active:scale-95 shadow-xl group/btn"
                  >
                    <span>Book Now</span>
                    <ExternalLink className="w-5 h-5 group-hover/btn:translate-x-1 transition-transform" />
                  </a>
                  <button 
                    onClick={() => setShowBookNow(false)}
                    className="text-amber-400/50 hover:text-amber-400 text-sm font-medium transition-colors"
                  >
                    Maybe later
                  </button>
                </div>
              </div>
              <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="text-sm text-gray-500 italic flex flex-col items-center space-y-2">
          <span>{isActive ? "Listening to your interior dreams..." : "Tap to start your premium interior consultation"}</span>
          {!showBookNow && isActive && (
            <button 
              onClick={() => setShowBookNow(true)}
              className="text-amber-500/40 hover:text-amber-500/80 transition-colors text-xs underline underline-offset-4"
            >
              Skip to Book Now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
