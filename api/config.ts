import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  
  // Security: Only send key if it's not a placeholder
  if (apiKey && apiKey !== "MY_GEMINI_API_KEY") {
    // Optional: Check Referer header here to restrict to your domain
    // const referer = request.headers.referer;
    // if (referer && !referer.includes('yourwebsite.com')) {
    //   return response.status(403).json({ error: "Forbidden" });
    // }
    
    response.status(200).json({ apiKey });
  } else {
    response.status(404).json({ error: "API Key not configured on server" });
  }
}
