const https = require("https");

const ANTHROPIC_KEY_PLACEHOLDER = "REPLACE_WITH_YOUR_ANTHROPIC_KEY";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

require("http").createServer(async (req, res) => {

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET") {
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ status: "Zorayx Lead Agent API running" }));
    return;
  }

  if (req.method === "POST" && req.url === "/search-leads") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { description, location, leadType } = JSON.parse(body);
        const isHospital = leadType === "hospital";

        const systemPrompt = isHospital
          ? `You are a B2B sales lead agent for Right Choice Medicare, a medical equipment supplier in India.
Use the web_search tool to find REAL hospitals, clinics and nursing homes in ${location} matching the user criteria.
Search JustDial, Practo, IndiaMART, hospital websites, news sources.
For each lead return a JSON object — all plain strings, never nested objects:
- name, type, location, size
- equipmentNeeds (array of strings)
- contactPerson (plain string e.g. "Dr. Ramesh Kumar, Medical Superintendent")
- phone (plain string), email (plain string)
- department, contactApproach
- score: "Hot" or "Warm" or "Cold"
- sourceUrl, notes
Return ONLY a JSON array starting with [. No markdown.`
          : `You are a talent sourcing agent for REMED (remed.in), a biomedical engineer marketplace in India.
Use the web_search tool to find REAL biomedical engineers and service companies in ${location}.
Search LinkedIn, JustDial, IndiaMART, AMC tender sites.
For each lead return a JSON object — all plain strings:
- name, profileType, location, experience
- specialization (array of strings)
- contactPerson (plain string), phone, email, outreach
- platformFit: "High" or "Medium" or "Low"
- sourceUrl, notes
Return ONLY a JSON array starting with [. No markdown.`;

        const anthropicPayload = JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: systemPrompt,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: `Find leads for: "${description}" in ${location}. Search the web and return a JSON array of real verified leads with contact details.`
          }]
        });

        const apiKey = process.env.ANTHROPIC_API_KEY || ANTHROPIC_KEY_PLACEHOLDER;

        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: "api.anthropic.com",
            path: "/v1/messages",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "web-search-2025-03-05",
              "Content-Length": Buffer.byteLength(anthropicPayload)
            }
          };
          const apiReq = https.request(options, apiRes => {
            let data = "";
            apiRes.on("data", chunk => data += chunk);
            apiRes.on("end", () => resolve({ status: apiRes.statusCode, body: data }));
          });
          apiReq.on("error", reject);
          apiReq.write(anthropicPayload);
          apiReq.end();
        });

        if (result.status !== 200) {
          res.writeHead(result.status, corsHeaders());
          res.end(result.body);
          return;
        }

        const parsed = JSON.parse(result.body);
        const text = (parsed.content || []).map(b => b.type === "text" ? b.text : "").join("\n").trim();
        const clean = text.replace(/```json|```/g, "").trim();
        const match = clean.match(/\[[\s\S]*\]/);
        const leads = match ? JSON.parse(match[0]) : [];

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ leads }));

      } catch (e) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: "Not found" }));

}).listen(process.env.PORT || 3000, () => {
  console.log("Zorayx Lead Agent API running on port", process.env.PORT || 3000);
});
