import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { Mic, MicOff, Volume2, VolumeX, Home, Layout, IndianRupee, Info, ExternalLink, Sparkles } from "lucide-react";
import { floatTo16BitPCM, base64ToArrayBuffer } from "../lib/audio-utils";

const SYSTEM_INSTRUCTION = `You are a premium Indian female voice assistant named "Interior Jarvis".
Speak in a natural Indian English accent (Hinglish/Indian English).
Tone: warm, polite, professional, smooth.
Avoid robotic pauses. Speak like a real human conversation.

Your goal is to help clients with interior design related questions.
You MUST follow this step-by-step flow:
1. Greet the user warmly. Ask: "Aap kya knowledge chahte hain? Budget planning, space planning, interior ideas, ya kuch aur questions hain?"
2. Wait for the user's answer.
3. Then ask for the space type: "Aapka space type kya hai? Jaise ki 1BHK, 2BHK, 3BHK, cafe, ya office?"
4. Wait for the user's answer.
5. Then ask for the carpet area: "Aapka carpet area kitna hai?"
6. Wait for the user's answer.
7. Then ask for the city: "Aap kaunse city se hain? (Budget planning ke liye zaroori hai)."
8. Provide detailed answers based on their inputs.
9. CTA: Finally, ask: "Agar aap hamare verified interior designer se complete guidance chahte hain, to reply kare Yes or No."
10. If they say "Yes", tell them: "Theek hai, main aapke liye 'Book Now' button show kar rahi hoon. Aap wahan click karke enquiry form bhar sakte hain."

--- INPUT VALIDATION RULES ---

• Carpet Area Validation:
If the user provides an unrealistic carpet area for the selected space type, do not proceed.
Realistic ranges:
- 1BHK: 300–800 sqft
- 2BHK: 600–1200 sqft
- 3BHK: 900–1800 sqft
- 4BHK: 1200–3000 sqft
If input is far outside these ranges, politely inform the user and ask for correct input.
Response: "The carpet area you provided seems unusual for the selected space type. Could you please recheck and enter a realistic area so I can give you an accurate estimate?"

• City Validation (India Only):
If the city is not in India or is unknown/unrecognized, do NOT proceed.
Ask user to provide a valid Indian city or mention their state.
Response: "I couldn't recognize the city you entered. Please provide a valid Indian city or mention your state so I can estimate costs accurately."

• Behavior Rules:
- Be polite and professional.
- Do not say "wrong input".
- Use phrases like: "seems unusual", "please recheck", "to give accurate estimate".
- No Assumptions: Do NOT auto-correct values. Always ask user to confirm correct input.
- Resume Flow: Once correct input is received, continue the normal process.
- Priority Rule: Always prioritize accuracy over speed. Never generate estimates based on doubtful or unrealistic inputs.

Always maintain your consistent Indian accent and professional tone.
Use Hinglish where appropriate to sound natural and premium.`;

export default function InteriorJarvis() {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [aiResponse, setAiResponse] = useState<string>("");
  const [showBookNow, setShowBookNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

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
    
    // 1. Check window.API_KEY (Platform runtime injection)
    key = (window as any).API_KEY || (window as any).GEMINI_API_KEY;
    
    // 2. Check backend API (Secure way for custom deployments)
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      try {
        const response = await fetch("/api/config");
        if (response.ok) {
          const data = await response.json();
          if (data.apiKey) {
            key = data.apiKey;
            console.log("API Key successfully fetched from backend.");
          }
        } else {
          console.error("Backend config fetch failed with status:", response.status);
        }
      } catch (e) {
        console.error("Error fetching backend config:", e);
      }
    }
    
    // 3. Check process.env (Vite build-time define or platform injection)
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      try {
        // @ts-ignore
        key = process.env.GEMINI_API_KEY || process.env.API_KEY;
      } catch (e) {}
    }
    
    // 4. Check import.meta.env (Vite standard)
    if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
      const metaEnv = (import.meta as any).env;
      if (metaEnv) {
        key = metaEnv.VITE_GEMINI_API_KEY || metaEnv.VITE_API_KEY || "";
      }
    }
    
    return key || "";
  };

  const startSession = async () => {
    setError(null);
    setIsConnecting(true);
    
    // Start microphone early to save time
    const micPromise = startMic();
    
    try {
      let apiKey = await getApiKey();
      
      // If we have a placeholder or no key, try to open the key selector
      if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
        await checkApiKey();
        // After checkApiKey, the platform should have injected the key
        apiKey = await getApiKey();
      }
      
      // Final check - if still no key, throw a more descriptive error
      if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey === "") {
        const isPublished = window.location.hostname.includes('run.app');
        const hasAiStudio = !!(window as any).aistudio;
        
        if (isPublished && !hasAiStudio) {
          throw new Error("API Key is missing. Agar aap Vercel par hain, toh check karein ki 'GEMINI_API_KEY' Environment Variable set kiya hai ya nahi. Variable add karne ke baad 'Redeploy' karna zaroori hai.");
        } else if (hasAiStudio) {
          throw new Error("Please select an API key to start the conversation.");
        } else {
          throw new Error("API Key is missing. Please configure it in the Secrets panel (lock icon) in AI Studio.");
        }
      }

      const ai = new GoogleGenAI({ apiKey });
      
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
                  
                  if (text.includes("yes") || text.includes("book now") || text.includes("button") || text.includes("theek hai")) {
                    setShowBookNow(true);
                  }
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMuted) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBuffer = floatTo16BitPCM(inputData);
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmBuffer)));
        
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

    isPlayingRef.current = true;
    const pcmData = audioQueueRef.current.shift()!;
    
    if (!audioContextRef.current) return;

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
