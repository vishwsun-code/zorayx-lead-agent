const https = require("https");
const http = require("http");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function callAnthropic(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "Content-Length": Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function extractLeadsFromResponse(responseBody) {
  // Parse all content blocks — text + tool_result blocks
  let allText = "";
  try {
    const parsed = JSON.parse(responseBody);
    const blocks = parsed.content || [];
    for (const block of blocks) {
      if (block.type === "text") {
        allText += block.text + "\n";
      }
      // Also check tool_result blocks which may contain extracted data
      if (block.type === "tool_result") {
        const content = block.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === "text") allText += c.text + "\n";
          }
        } else if (typeof content === "string") {
          allText += content + "\n";
        }
      }
    }
  } catch(e) {
    // If can't parse, try to extract JSON array directly from raw body
    allText = responseBody;
  }

  // Find JSON array in the text
  const clean = allText.replace(/```json|```/g, "").trim();
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const leads = JSON.parse(match[0]);
    return Array.isArray(leads) ? leads : [];
  } catch(e) {
    return [];
  }
}

http.createServer(async (req, res) => {

  // Handle preflight CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET") {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ status: "Zorayx Lead Agent API running", version: "2.0" }));
    return;
  }

  if (req.method === "POST" && req.url === "/search-leads") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { description, location, leadType } = JSON.parse(body);

        if (!description || !location || !leadType) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ error: "Missing description, location or leadType" }));
          return;
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          res.writeHead(500, corsHeaders());
          res.end(JSON.stringify({ error: "ANTHROPIC_API_KEY not set on server" }));
          return;
        }

        const isHospital = leadType === "hospital";

        const systemPrompt = isHospital
          ? `You are a B2B sales lead agent for Right Choice Medicare, a medical equipment supplier in India.
Search the web to find REAL hospitals, clinics and nursing homes in ${location} that could buy medical equipment.
Search JustDial, Practo, IndiaMART, hospital websites and news sources.

For each lead return a JSON object with ALL fields as plain strings (never nested objects):
- name: hospital name (string)
- type: e.g. "Multi-Specialty Hospital" (string)
- location: city, state (string)
- size: bed count or Small/Medium/Large (string)
- equipmentNeeds: array of strings e.g. ["ICU Monitors", "Ventilators"]
- contactPerson: "Name, Designation" as ONE plain string e.g. "Dr. Ramesh Kumar, Medical Superintendent"
- phone: phone number as plain string e.g. "011-12345678"
- email: email as plain string e.g. "procurement@hospital.com"
- department: "Purchase Dept" or "Biomedical Dept" (string)
- contactApproach: how to reach them (string)
- score: exactly one of "Hot" or "Warm" or "Cold"
- sourceUrl: URL where you found this (string)
- notes: brief notes (string)

Find at least 5-8 leads. Return ONLY a valid JSON array. No explanation. No markdown. Start with [`
          : `You are a talent sourcing agent for REMED (remed.in), a biomedical engineer marketplace in India.
Search the web to find REAL biomedical engineers, technicians and AMC service companies in ${location}.
Search LinkedIn, JustDial, IndiaMART and hospital AMC tender sites.

For each lead return a JSON object with ALL fields as plain strings:
- name: person or company name (string)
- profileType: "Independent BME" or "Service Company" or "Hospital AMC Provider" (string)
- location: city, state (string)
- specialization: array of strings e.g. ["Ventilators", "ICU Equipment"]
- experience: e.g. "5 years" (string)
- contactPerson: full name as plain string
- phone: phone number as plain string
- email: email as plain string
- outreach: best way to reach (string)
- platformFit: exactly one of "High" or "Medium" or "Low"
- sourceUrl: URL where found (string)
- notes: brief notes (string)

Find at least 5-8 leads. Return ONLY a valid JSON array. No explanation. No markdown. Start with [`;

        const payload = {
          model: "claude-sonnet-4-20250514",
          max_tokens: 5000,
          system: systemPrompt,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `Search the web and find real verified leads for: "${description}" in ${location}. Return as JSON array.`
          }]
        };

        const result = await callAnthropic(payload, apiKey);

        if (result.status !== 200) {
          let errMsg = `Anthropic API error ${result.status}`;
          try {
            const errBody = JSON.parse(result.body);
            errMsg = errBody?.error?.message || errMsg;
          } catch(e) {}
          res.writeHead(500, corsHeaders());
          res.end(JSON.stringify({ error: errMsg }));
          return;
        }

        const leads = extractLeadsFromResponse(result.body);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ leads, count: leads.length }));

      } catch (e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: e.message || "Internal server error" }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: "Not found" }));

}).listen(process.env.PORT || 3000, () => {
  console.log("Zorayx Lead Agent API v2.0 running on port", process.env.PORT || 3000);
});
